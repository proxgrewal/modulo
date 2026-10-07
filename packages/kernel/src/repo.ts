import { recordValidator, slugify, type ModelField } from '@modulo/core';
import { ident } from './db.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors.ts';
import type { ComposedModel } from './schema.ts';
import { storedColumns } from './schema.ts';
import type { SiteContext } from './context.ts';

/**
 * Site-scoped repository over a composed model. Enforces access rules,
 * validation, slugs, computed fields and hooks; every query runs inside a
 * transaction with RLS bound to the site (plus an explicit site_id filter as
 * defence in depth).
 */
export type Rec = Record<string, any> & { id: string };

export type WhereValue =
  | unknown
  | { eq?: unknown; ne?: unknown; gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown; in?: unknown[]; like?: string; ilike?: string; null?: boolean };
export type Where = { [field: string]: WhereValue } & { $or?: Where[] };

export interface FindQuery {
  where?: Where;
  order?: string;
  limit?: number;
  offset?: number;
  /** Case-insensitive search across string/text fields. */
  search?: string;
}

const SYSTEM_COLS = ['id', 'site_id', 'created_at', 'updated_at', 'created_by'];

export class Repository {
  constructor(
    private ctx: SiteContext,
    public model: ComposedModel,
  ) {}

  /** Fields visible to this site (extension fields from uninstalled modules are hidden). */
  get fields(): Record<string, ModelField & { name: string; module: string }> {
    const installed = this.ctx.runtime.installed;
    return Object.fromEntries(Object.entries(this.model.fields).filter(([, f]) => installed.has(f.module)));
  }

  private get computed() {
    const installed = this.ctx.runtime.installed;
    return Object.values(this.model.computed).filter((c) => installed.has(c.module));
  }

  private checkAccess(op: 'read' | 'create' | 'update' | 'delete') {
    if (this.ctx.sudo) return;
    const rule = this.model.access[op] ?? (op === 'read' ? 'auth' : `${this.model.module}.manage`);
    if (rule === 'public') return;
    if (!this.ctx.user) throw new ForbiddenError(`Sign in to ${op} ${this.model.name}`);
    if (rule === 'auth') return;
    if (!this.ctx.can(rule)) throw new ForbiddenError(`Missing permission "${rule}" to ${op} ${this.model.name}`);
  }

  private col(name: string): string {
    if (SYSTEM_COLS.includes(name) || this.fields[name] || this.model.computed[name]?.stored) return ident(name);
    throw new ValidationError(`Unknown field "${name}" on ${this.model.name}`);
  }

  private buildWhere(where: Where | undefined, params: unknown[]): string {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(where ?? {})) {
      if (k === '$or') {
        const ors = (v as Where[]).map((w) => `(${this.buildWhere(w, params) || 'TRUE'})`);
        if (ors.length) parts.push(`(${ors.join(' OR ')})`);
        continue;
      }
      const c = this.col(k);
      const p = (val: unknown) => {
        params.push(val);
        return `$${params.length}`;
      };
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
        const o = v as Record<string, unknown>;
        if ('eq' in o) parts.push(`${c} = ${p(o.eq)}`);
        if ('ne' in o) parts.push(`${c} IS DISTINCT FROM ${p(o.ne)}`);
        if ('gt' in o) parts.push(`${c} > ${p(o.gt)}`);
        if ('gte' in o) parts.push(`${c} >= ${p(o.gte)}`);
        if ('lt' in o) parts.push(`${c} < ${p(o.lt)}`);
        if ('lte' in o) parts.push(`${c} <= ${p(o.lte)}`);
        if ('in' in o) parts.push((o.in as unknown[]).length ? `${c} = ANY(${p(o.in)})` : 'FALSE');
        if ('like' in o) parts.push(`${c} LIKE ${p(o.like)}`);
        if ('ilike' in o) parts.push(`${c} ILIKE ${p(o.ilike)}`);
        if ('null' in o) parts.push(o.null ? `${c} IS NULL` : `${c} IS NOT NULL`);
      } else if (v === null) parts.push(`${c} IS NULL`);
      else parts.push(`${c} = ${p(v)}`);
    }
    return parts.join(' AND ');
  }

  private orderBy(order?: string): string {
    const o = order ?? this.model.order ?? 'created_at desc';
    return o
      .split(',')
      .map((part) => {
        const [f, dir] = part.trim().split(/\s+/);
        return `${this.col(f!)} ${dir?.toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`;
      })
      .join(', ');
  }

  private normalise(row: Record<string, any>): Rec {
    const out: Record<string, any> = {};
    for (const k of SYSTEM_COLS) if (k in row) out[k] = row[k] instanceof Date ? row[k].toISOString() : row[k];
    for (const [k, f] of Object.entries(this.fields)) {
      let v = row[k];
      if (v === undefined) continue;
      if (v !== null) {
        if (f.kind === 'money' || (f.kind === 'float' && typeof v === 'string')) v = Number(v);
        else if (f.kind === 'date') v = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
        else if (f.kind === 'datetime') v = v instanceof Date ? v.toISOString() : new Date(v).toISOString();
      }
      if (f.private && !this.ctx.user && !this.ctx.sudo) continue;
      out[k] = v;
    }
    for (const c of this.computed) out[c.name] = c.stored ? row[c.name] : safeCompute(c.compute, out);
    return out as Rec;
  }

  private async scopedWhere(where: Where | undefined): Promise<Where | undefined> {
    return this.ctx.hooks.filter(`model.${this.model.name}.where`, where, this.ctx);
  }

  async find(q: FindQuery = {}): Promise<Rec[]> {
    if (!this.ctx.inSiteTx) return this.ctx.tx((c) => c.repo(this.model.name).find(q));
    this.checkAccess('read');
    const ctx = this.ctx;
    {
      const params: unknown[] = [ctx.site.id];
      const where = await this.scopedWhere(q.where);
      let sql = `SELECT * FROM ${ident(this.model.table)} WHERE site_id = $1`;
      const w = this.buildWhere(where, params);
      if (w) sql += ` AND ${w}`;
      if (q.search) {
        const cols = Object.values(this.fields).filter((f) => ['string', 'text', 'slug', 'email'].includes(f.kind));
        if (cols.length) {
          params.push(`%${q.search.replace(/[%_]/g, (m) => '\\' + m)}%`);
          sql += ` AND (${cols.map((c) => `${ident(c.name)} ILIKE $${params.length}`).join(' OR ')})`;
        }
      }
      sql += ` ORDER BY ${this.orderBy(q.order)}`;
      params.push(Math.min(Math.max(q.limit ?? 50, 1), 1000));
      sql += ` LIMIT $${params.length}`;
      if (q.offset) {
        params.push(q.offset);
        sql += ` OFFSET $${params.length}`;
      }
      const r = await ctx.db.query(sql, params);
      return r.rows.map((row) => this.normalise(row));
    }
  }

  async count(where?: Where): Promise<number> {
    if (!this.ctx.inSiteTx) return this.ctx.tx((c) => c.repo(this.model.name).count(where));
    this.checkAccess('read');
    const ctx = this.ctx;
    {
      const params: unknown[] = [ctx.site.id];
      const w = this.buildWhere(await this.scopedWhere(where), params);
      const r = await ctx.db.query(`SELECT count(*)::int AS n FROM ${ident(this.model.table)} WHERE site_id = $1${w ? ' AND ' + w : ''}`, params);
      return Number(r.rows[0].n);
    }
  }

  async findOne(where: Where): Promise<Rec | null> {
    return (await this.find({ where, limit: 1 }))[0] ?? null;
  }

  async get(id: string): Promise<Rec> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError(`${this.model.name} ${id} not found`);
    const r = await this.findOne({ id });
    if (!r) throw new NotFoundError(`${this.model.name} ${id} not found`);
    return r;
  }

  private validate(values: Record<string, unknown>, mode: 'create' | 'update') {
    const res = recordValidator(this.fields, mode).safeParse(values);
    if (!res.success) {
      throw new ValidationError(
        `Invalid ${this.model.name}: ` + res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
        res.error.issues,
      );
    }
    return res.data as Record<string, unknown>;
  }

  private async fillSlugs(values: Record<string, any>, excludeId?: string) {
    for (const f of Object.values(this.fields)) {
      if (f.kind !== 'slug') continue;
      if (values[f.name] === undefined && excludeId) continue; // untouched on update
      let base = values[f.name] ? slugify(String(values[f.name])) : f.from && values[f.from] ? slugify(String(values[f.from])) : '';
      if (!base) {
        if (f.required || f.from) base = 'item';
        else continue;
      }
      let candidate = base;
      for (let i = 2; i < 1000; i++) {
        const params: unknown[] = [this.ctx.site.id, candidate];
        let sql = `SELECT 1 FROM ${ident(this.model.table)} WHERE site_id=$1 AND ${ident(f.name)}=$2`;
        if (excludeId) {
          params.push(excludeId);
          sql += ` AND id <> $3`;
        }
        if (!(await this.ctx.db.query(sql, params)).rows.length) break;
        candidate = `${base}-${i}`;
      }
      values[f.name] = candidate;
    }
  }

  private applyStoredComputed(full: Record<string, any>, changed: string[] | null, target: Record<string, any>) {
    for (const c of this.computed) {
      if (!c.stored) continue;
      if (changed && !c.depends.some((d) => changed.includes(d))) continue;
      target[c.name] = safeCompute(c.compute, full);
    }
  }

  private colExpr(name: string, idx: number): string {
    const f = this.fields[name];
    if (f?.kind === 'json') return `$${idx}::jsonb`;
    const c = this.model.computed[name];
    if (c?.kind === 'json') return `$${idx}::jsonb`;
    return `$${idx}`;
  }

  private param(name: string, v: unknown): unknown {
    const kind = this.fields[name]?.kind ?? this.model.computed[name]?.kind;
    if (kind === 'json') return v === undefined ? null : JSON.stringify(v);
    return v;
  }

  async create(values: Record<string, unknown>): Promise<Rec> {
    if (!this.ctx.inSiteTx) return this.ctx.tx((c) => c.repo(this.model.name).create(values));
    this.checkAccess('create');
    const ctx = this.ctx;
    return (
      ctx.hooks.around(
        `model.${this.model.name}.create`,
        { values },
        async ({ values: input }) => {
          let v = await ctx.hooks.filter(`model.${this.model.name}.beforeCreate`, { ...input }, ctx);
          for (const f of Object.values(this.fields)) if (v[f.name] === undefined && f.default !== undefined) v[f.name] = structuredClone(f.default);
          v = this.validate(v, 'create');
          await this.fillSlugs(v);
          this.applyStoredComputed(v, null, v);
          const names = Object.keys(v).filter((k) => v[k] !== undefined);
          const params: unknown[] = [ctx.site.id, ctx.user?.id ?? null, ...names.map((n) => this.param(n, v[n]))];
          const sql = `INSERT INTO ${ident(this.model.table)} (site_id, created_by${names.map((n) => ', ' + ident(n)).join('')})
                       VALUES ($1, $2${names.map((n, i) => ', ' + this.colExpr(n, i + 3)).join('')}) RETURNING *`;
          const row = await runWrite(() => ctx.db.query(sql, params));
          const rec = this.normalise(row.rows[0]);
          await ctx.hooks.action(`model.${this.model.name}.afterCreate`, rec, ctx);
          await ctx.emit(`${this.model.name}.created`, { id: rec.id });
          return rec;
        },
        ctx,
      )
    );
  }

  async update(id: string, values: Record<string, unknown>): Promise<Rec> {
    if (!this.ctx.inSiteTx) return this.ctx.tx((c) => c.repo(this.model.name).update(id, values));
    this.checkAccess('update');
    const ctx = this.ctx;
    return (
      ctx.hooks.around(
        `model.${this.model.name}.update`,
        { id, values },
        async ({ id: rid, values: input }) => {
          const existing = await this.get(rid);
          let v = await ctx.hooks.filter(`model.${this.model.name}.beforeUpdate`, { ...input }, existing, ctx);
          v = this.validate(v, 'update');
          await this.fillSlugs(v, rid);
          const merged = { ...existing, ...v };
          this.applyStoredComputed(merged, Object.keys(v), v);
          const names = Object.keys(v).filter((k) => v[k] !== undefined);
          if (!names.length) return existing;
          const params: unknown[] = [ctx.site.id, rid, ...names.map((n) => this.param(n, v[n]))];
          const sql = `UPDATE ${ident(this.model.table)} SET updated_at = now()${names.map((n, i) => `, ${ident(n)} = ${this.colExpr(n, i + 3)}`).join('')}
                       WHERE site_id = $1 AND id = $2 RETURNING *`;
          const row = await runWrite(() => ctx.db.query(sql, params));
          const rec = this.normalise(row.rows[0]);
          await ctx.hooks.action(`model.${this.model.name}.afterUpdate`, rec, existing, ctx);
          await ctx.emit(`${this.model.name}.updated`, { id: rec.id, changed: names });
          return rec;
        },
        ctx,
      )
    );
  }

  async delete(id: string): Promise<void> {
    if (!this.ctx.inSiteTx) return this.ctx.tx((c) => c.repo(this.model.name).delete(id));
    this.checkAccess('delete');
    const ctx = this.ctx;
    await (
      ctx.hooks.around(
        `model.${this.model.name}.delete`,
        { id },
        async ({ id: rid }) => {
          const existing = await this.get(rid);
          await ctx.hooks.action(`model.${this.model.name}.beforeDelete`, existing, ctx);
          await runWrite(() => ctx.db.query(`DELETE FROM ${ident(this.model.table)} WHERE site_id = $1 AND id = $2`, [ctx.site.id, rid]));
          await ctx.hooks.action(`model.${this.model.name}.afterDelete`, existing, ctx);
          await ctx.emit(`${this.model.name}.deleted`, { id: rid });
        },
        ctx,
      )
    );
  }

  /** Columns as visible to this site (for admin UIs / API docs). */
  describe() {
    return {
      name: this.model.name,
      label: this.model.label,
      module: this.model.module,
      titleField: this.model.titleField,
      fields: this.fields,
      computed: Object.fromEntries(this.computed.map((c) => [c.name, { kind: c.kind, depends: c.depends, stored: !!c.stored, module: c.module }])),
      access: this.model.access,
      columns: storedColumns(this.model).map((c) => c.name),
    };
  }
}

function safeCompute(fn: (r: Record<string, any>) => unknown, rec: Record<string, any>) {
  try {
    return fn(rec);
  } catch {
    return null;
  }
}

async function runWrite<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (e?.code === '23505' || /duplicate key/i.test(msg)) throw new ConflictError('A record with that value already exists', msg);
    if (e?.code === '23503' || /foreign key/i.test(msg)) throw new ValidationError('Referenced record does not exist or is still in use', msg);
    throw e;
  }
}
