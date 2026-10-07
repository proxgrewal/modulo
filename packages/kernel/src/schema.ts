import {
  FIELD_NAME_RE,
  MODEL_NAME_RE,
  RESERVED_FIELDS,
  tableName,
  type ComputedField,
  type ModelAccess,
  type ModelField,
} from '@modulo/core';
import { ident, type Db } from './db.ts';
import type { ModuleDefinition } from './module.ts';
import { APP_ROLE } from './system.ts';

/**
 * Model registry + schema compiler. Composes model definitions with every
 * module's additive extensions (Odoo `_inherit` without MRO), then syncs real
 * PostgreSQL tables: create table, add columns, indexes, FKs, RLS policies.
 * Never drops columns automatically; incompatible type changes require an
 * explicit module migration.
 */
export interface ComposedField extends ModelField {
  name: string;
  module: string;
}

export interface ComposedComputed extends ComputedField {
  name: string;
  module: string;
}

export interface ComposedModel {
  name: string;
  module: string;
  table: string;
  label: string;
  titleField?: string;
  fields: Record<string, ComposedField>;
  computed: Record<string, ComposedComputed>;
  indexes: { fields: string[]; unique?: boolean }[];
  access: ModelAccess;
  order?: string;
}

export class SchemaError extends Error {
  constructor(public problems: string[]) {
    super('Schema problems:\n' + problems.map((p) => '  - ' + p).join('\n'));
  }
}

export function composeModels(defs: ModuleDefinition[]): Map<string, ComposedModel> {
  const models = new Map<string, ComposedModel>();
  const problems: string[] = [];
  const addField = (m: ComposedModel, name: string, f: ModelField, module: string) => {
    if (!FIELD_NAME_RE.test(name) || RESERVED_FIELDS.has(name)) problems.push(`${module}: invalid or reserved field name "${m.name}.${name}"`);
    else if (m.fields[name] || m.computed[name]) problems.push(`${module}: field "${m.name}.${name}" already defined by ${m.fields[name]?.module ?? m.computed[name]?.module}`);
    else m.fields[name] = { ...f, name, module };
  };
  const addComputed = (m: ComposedModel, name: string, c: ComputedField, module: string) => {
    if (m.fields[name] || m.computed[name]) problems.push(`${module}: computed "${m.name}.${name}" collides`);
    else m.computed[name] = { ...c, name, module };
  };
  for (const def of defs) {
    for (const md of def.models ?? []) {
      if (!MODEL_NAME_RE.test(md.name)) problems.push(`${def.name}: invalid model name "${md.name}"`);
      if (!md.name.startsWith(def.name.replace(/-/g, '_') + '.') && !md.name.startsWith(def.name + '.')) {
        problems.push(`${def.name}: model "${md.name}" must be namespaced "${def.name.replace(/-/g, '_')}.<name>"`);
      }
      if (models.has(md.name)) {
        problems.push(`${def.name}: model ${md.name} already defined by ${models.get(md.name)!.module}`);
        continue;
      }
      const m: ComposedModel = {
        name: md.name,
        module: def.name,
        table: tableName(md.name),
        label: md.label ?? md.name,
        titleField: md.titleField,
        fields: {},
        computed: {},
        indexes: [...(md.indexes ?? [])],
        access: md.access ?? {},
        order: md.order,
      };
      for (const [n, f] of Object.entries(md.fields)) addField(m, n, f, def.name);
      for (const [n, c] of Object.entries(md.computed ?? {})) addComputed(m, n, c, def.name);
      models.set(md.name, m);
    }
  }
  // Extensions apply in module order (defs are already dependency-sorted).
  for (const def of defs) {
    for (const ext of def.extendModels ?? []) {
      const m = models.get(ext.model);
      if (!m) {
        problems.push(`${def.name}: extends unknown model ${ext.model} (missing dependency?)`);
        continue;
      }
      for (const [n, f] of Object.entries(ext.fields ?? {})) addField(m, n, f, def.name);
      for (const [n, c] of Object.entries(ext.computed ?? {})) addComputed(m, n, c, def.name);
      m.indexes.push(...(ext.indexes ?? []));
    }
  }
  for (const m of models.values()) {
    for (const f of Object.values(m.fields)) {
      if (f.kind === 'ref' && (!f.model || !models.has(f.model))) problems.push(`${f.module}: ${m.name}.${f.name} references unknown model ${f.model}`);
      if (f.kind === 'enum' && !f.options?.length) problems.push(`${f.module}: ${m.name}.${f.name} enum has no options`);
    }
    for (const c of Object.values(m.computed)) {
      for (const d of c.depends) if (!m.fields[d] && !m.computed[d]) problems.push(`${c.module}: ${m.name}.${c.name} depends on unknown field ${d}`);
    }
  }
  if (problems.length) throw new SchemaError(problems);
  return models;
}

export function sqlType(f: Pick<ModelField, 'kind' | 'max'>): string {
  switch (f.kind) {
    case 'string':
    case 'slug':
    case 'email':
    case 'url':
      return `varchar(${f.max ?? 255})`;
    case 'text':
    case 'richtext':
    case 'media':
    case 'enum':
      return 'text';
    case 'int':
      return 'integer';
    case 'float':
      return 'double precision';
    case 'money':
      return 'numeric(14,2)';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'datetime':
      return 'timestamptz';
    case 'json':
      return 'jsonb';
    case 'ref':
      return 'uuid';
  }
}

/** information_schema-normalised type for comparison. */
function normalisedType(f: Pick<ModelField, 'kind' | 'max'>): { type: string; len?: number } {
  const t = sqlType(f);
  const m = /^varchar\((\d+)\)$/.exec(t);
  if (m) return { type: 'character varying', len: Number(m[1]) };
  const map: Record<string, string> = { 'numeric(14,2)': 'numeric', timestamptz: 'timestamp with time zone' };
  return { type: map[t] ?? t };
}

export function storedColumns(m: ComposedModel): { name: string; field: Pick<ModelField, 'kind' | 'max'> & Partial<ModelField> }[] {
  return [
    ...Object.values(m.fields).map((f) => ({ name: f.name, field: f })),
    ...Object.values(m.computed)
      .filter((c) => c.stored)
      .map((c) => ({ name: c.name, field: { kind: c.kind } })),
  ];
}

export interface SyncReport {
  createdTables: string[];
  addedColumns: string[];
  alteredColumns: string[];
  indexes: string[];
}

export async function syncSchema(db: Db, models: Map<string, ComposedModel>): Promise<SyncReport> {
  const report: SyncReport = { createdTables: [], addedColumns: [], alteredColumns: [], indexes: [] };
  const problems: string[] = [];

  for (const m of models.values()) {
    const t = ident(m.table);
    const exists = (await db.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [m.table])).rows.length > 0;
    if (!exists) {
      const cols = storedColumns(m).map((c) => `${ident(c.name)} ${sqlType(c.field)}`);
      await db.exec(
        `CREATE TABLE ${t} (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          site_id uuid NOT NULL REFERENCES modulo_sites(id) ON DELETE CASCADE,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          created_by uuid${cols.length ? ',\n' + cols.join(',\n') : ''}
        );
        CREATE INDEX IF NOT EXISTS ${ident(m.table + '_site')} ON ${t} (site_id);`,
      );
      report.createdTables.push(m.table);
    } else {
      const existing = new Map(
        (
          await db.query<{ column_name: string; data_type: string; character_maximum_length: number | null }>(
            `SELECT column_name, data_type, character_maximum_length FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
            [m.table],
          )
        ).rows.map((r) => [r.column_name, r]),
      );
      for (const c of storedColumns(m)) {
        const cur = existing.get(c.name);
        const want = normalisedType(c.field);
        if (!cur) {
          await db.exec(`ALTER TABLE ${t} ADD COLUMN ${ident(c.name)} ${sqlType(c.field)}`);
          report.addedColumns.push(`${m.table}.${c.name}`);
        } else if (cur.data_type !== want.type) {
          problems.push(`${m.name}.${c.name}: column is ${cur.data_type}, definition wants ${want.type} — add a schema migration`);
        } else if (want.len && cur.character_maximum_length !== null && want.len > cur.character_maximum_length) {
          await db.exec(`ALTER TABLE ${t} ALTER COLUMN ${ident(c.name)} TYPE varchar(${want.len})`);
          report.alteredColumns.push(`${m.table}.${c.name}`);
        }
      }
    }
  }
  if (problems.length) throw new SchemaError(problems);

  // Indexes, uniques (per site), FKs, RLS — all idempotent.
  for (const m of models.values()) {
    const t = ident(m.table);
    const idx: { name: string; cols: string[]; unique: boolean }[] = [];
    for (const f of Object.values(m.fields)) {
      if (f.unique) idx.push({ name: `${m.table}_${f.name}_uq`, cols: ['site_id', f.name], unique: true });
      else if (f.index || f.kind === 'ref') idx.push({ name: `${m.table}_${f.name}_ix`, cols: ['site_id', f.name], unique: false });
    }
    for (const i of m.indexes) idx.push({ name: `${m.table}_${i.fields.join('_')}_${i.unique ? 'uq' : 'ix'}`, cols: ['site_id', ...i.fields], unique: !!i.unique });
    for (const i of idx) {
      const name = i.name.slice(0, 63);
      await db.exec(`CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${ident(name)} ON ${t} (${i.cols.map(ident).join(', ')})`);
      report.indexes.push(name);
    }
    for (const f of Object.values(m.fields)) {
      if (f.kind !== 'ref') continue;
      const target = models.get(f.model!)!;
      const cname = `${m.table}_${f.name}_fk`.slice(0, 63);
      const has = (await db.query(`SELECT 1 FROM pg_constraint WHERE conname=$1`, [cname])).rows.length > 0;
      if (!has) {
        const onDel = f.onDelete === 'cascade' ? 'CASCADE' : f.onDelete === 'restrict' ? 'RESTRICT' : 'SET NULL';
        await db.exec(`ALTER TABLE ${t} ADD CONSTRAINT ${ident(cname)} FOREIGN KEY (${ident(f.name)}) REFERENCES ${ident(target.table)}(id) ON DELETE ${onDel}`);
      }
    }
    const pol = (await db.query(`SELECT 1 FROM pg_policies WHERE tablename=$1 AND policyname='site_isolation'`, [m.table])).rows.length > 0;
    if (!pol) {
      await db.exec(
        `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
         ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
         CREATE POLICY site_isolation ON ${t}
           USING (site_id = nullif(current_setting('app.site_id', true), '')::uuid)
           WITH CHECK (site_id = nullif(current_setting('app.site_id', true), '')::uuid);`,
      );
    }
  }
  await db.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};`);

  for (const m of models.values()) {
    const def = {
      label: m.label,
      titleField: m.titleField,
      // jsonb does not preserve key order; keep it explicitly for UIs.
      fieldOrder: Object.keys(m.fields),
      fields: m.fields,
      computed: Object.fromEntries(Object.values(m.computed).map((c) => [c.name, { kind: c.kind, depends: c.depends, stored: !!c.stored, module: c.module }])),
      access: m.access,
    };
    await db.query(
      `INSERT INTO modulo_models (name, module, def) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (name) DO UPDATE SET module = EXCLUDED.module, def = EXCLUDED.def, updated_at = now()`,
      [m.name, m.module, JSON.stringify(def)],
    );
  }
  return report;
}
