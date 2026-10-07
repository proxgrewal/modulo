import { createHmac, randomBytes } from 'node:crypto';
import semver from 'semver';
import { fieldsToZod, mergeTheme, defaultTheme, type Theme } from '@modulo/core';
import { createUser, type UserRow } from './auth.ts';
import { runInSiteTx, SiteContext, type SiteInfo, type UserInfo } from './context.ts';
import type { Db } from './db.ts';
import { ConflictError, ModuloError, NotFoundError, ValidationError } from './errors.ts';
import { KERNEL_API_VERSION, type ModuleDefinition } from './module.ts';
import { applyShippedRecords, type RecordsReport } from './records.ts';
import { dependents, MapCatalog, resolve, ResolveError, type Lockfile } from './resolver.ts';
import { SiteRuntime } from './runtime.ts';
import { composeModels, syncSchema, type ComposedModel, type SyncReport } from './schema.ts';
import { APP_ROLE, ensureSystemSchema } from './system.ts';
import { toposort } from './toposort.ts';

export interface KernelOptions {
  db: Db;
  modules: ModuleDefinition[];
  log?: (msg: string, extra?: unknown) => void;
}

export interface ModuleChange {
  install?: Record<string, string>;
  uninstall?: string[];
  upgrade?: string[];
  /** Also uninstall modules that depend on the ones being removed. */
  cascade?: boolean;
}

export interface InstallPlan {
  lock: Lockfile;
  defs: ModuleDefinition[];
  added: { name: string; version: string }[];
  removed: { name: string; version: string }[];
  upgraded: { name: string; from: string; to: string }[];
  conflicts: ReturnType<SiteRuntime['conflicts']>;
  patchFailures: { template: string; patch: string; module: string; target: string; reason: string }[];
}

export interface InstallReport extends InstallPlan {
  schema: SyncReport | null;
  records: Record<string, RecordsReport>;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The microkernel: module catalog, schema composition, per-site runtimes,
 * transactional install/uninstall/upgrade, contexts, and the event/job worker.
 */
export class Kernel {
  readonly db: Db;
  readonly catalog: MapCatalog;
  models = new Map<string, ComposedModel>();
  readonly version = KERNEL_API_VERSION;
  private runtimes = new Map<string, Promise<SiteRuntime>>();
  private log: (msg: string, extra?: unknown) => void;
  private worker: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(siteId: string, event: string, payload: any) => void | Promise<void>>();
  private working = false;

  private constructor(opts: KernelOptions) {
    this.db = opts.db;
    this.catalog = new MapCatalog(opts.modules);
    this.log = opts.log ?? (() => {});
  }

  static async create(opts: KernelOptions): Promise<Kernel> {
    const k = new Kernel(opts);
    await ensureSystemSchema(k.db);
    await k.recompose();
    return k;
  }

  /* ───────────────────────── schema ───────────────────────── */

  /** Newest installed version of each module across all sites, plus `extra` (planned) defs. */
  private async schemaDefs(extra: ModuleDefinition[] = []): Promise<ModuleDefinition[]> {
    const rows = (await this.db.query<{ module: string; version: string }>(`SELECT DISTINCT module, version FROM modulo_site_modules`)).rows;
    const pick = new Map<string, ModuleDefinition>();
    const consider = (d: ModuleDefinition | undefined) => {
      if (!d) return;
      const cur = pick.get(d.name);
      if (!cur || semver.gt(d.version, cur.version)) pick.set(d.name, d);
    };
    for (const r of rows) consider(this.catalog.get(r.module).find((d) => d.version === r.version) ?? this.catalog.get(r.module)[0]);
    extra.forEach(consider);
    const names = [...pick.keys()].sort();
    const edges = new Map(names.map((n) => [n, new Set(Object.keys(pick.get(n)!.depends ?? {}))]));
    return toposort(names, edges).map((n) => pick.get(n)!);
  }

  /** Compose models and sync the database schema (runs pending schema migrations first). */
  async recompose(extra: ModuleDefinition[] = []): Promise<SyncReport> {
    const defs = await this.schemaDefs(extra);
    const models = composeModels(defs);
    const report = await this.db.tx(async (t) => {
      const recorded = new Map((await t.query<{ module: string; version: string }>(`SELECT module, version FROM modulo_schema_versions`)).rows.map((r) => [r.module, r.version]));
      for (const d of defs) {
        const from = recorded.get(d.name);
        if (from && semver.lt(from, d.version)) {
          const steps = Object.keys(d.migrations ?? {})
            .filter((v) => semver.valid(v) && semver.gt(v, from) && semver.lte(v, d.version))
            .sort(semver.compare);
          for (const v of steps) {
            const m = d.migrations![v]!;
            if (m.schema) {
              this.log(`schema migration ${d.name}@${v}`);
              await m.schema(t);
            }
          }
        }
      }
      const rep = await syncSchema(t, models);
      for (const d of defs) {
        const from = recorded.get(d.name);
        if (from && semver.gte(from, d.version)) continue;
        await t.query(
          `INSERT INTO modulo_schema_versions (module, version) VALUES ($1,$2) ON CONFLICT (module) DO UPDATE SET version=EXCLUDED.version, applied_at=now()`,
          [d.name, d.version],
        );
      }
      return rep;
    });
    this.models = models;
    return report;
  }

  /* ───────────────────────── sites ───────────────────────── */

  private toSite(r: any): SiteInfo {
    return { id: r.id, slug: r.slug, name: r.name, domain: r.domain, theme: r.theme ?? {}, settings: r.settings ?? {}, plan: r.plan };
  }

  async getSite(idOrSlug: string): Promise<SiteInfo> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
    const r = await this.db.query(`SELECT * FROM modulo_sites WHERE ${isUuid ? 'id' : 'slug'} = $1`, [idOrSlug]);
    if (!r.rows[0]) throw new NotFoundError(`Site ${idOrSlug} not found`);
    return this.toSite(r.rows[0]);
  }

  async findSiteByDomain(host: string): Promise<SiteInfo | null> {
    const r = await this.db.query(`SELECT * FROM modulo_sites WHERE domain = $1`, [host.toLowerCase()]);
    return r.rows[0] ? this.toSite(r.rows[0]) : null;
  }

  async listSites(userId?: string): Promise<(SiteInfo & { role?: string })[]> {
    const r = userId
      ? await this.db.query(`SELECT s.*, m.role FROM modulo_sites s JOIN modulo_members m ON m.site_id = s.id WHERE m.user_id = $1 ORDER BY s.created_at`, [userId])
      : await this.db.query(`SELECT * FROM modulo_sites ORDER BY created_at`);
    return r.rows.map((row) => ({ ...this.toSite(row), role: row.role }));
  }

  async createSite(input: { slug: string; name: string; ownerId?: string; modules?: Record<string, string>; theme?: Partial<Theme> }): Promise<SiteInfo> {
    if (!SLUG_RE.test(input.slug)) throw new ValidationError('Site slug must be lowercase letters, digits and dashes');
    const exists = await this.db.query(`SELECT 1 FROM modulo_sites WHERE slug=$1`, [input.slug]);
    if (exists.rows.length) throw new ConflictError(`Site "${input.slug}" already exists`);
    const r = await this.db.query(`INSERT INTO modulo_sites (slug, name, theme) VALUES ($1,$2,$3::jsonb) RETURNING *`, [
      input.slug,
      input.name,
      JSON.stringify(input.theme ?? {}),
    ]);
    const site = this.toSite(r.rows[0]);
    if (input.ownerId) await this.db.query(`INSERT INTO modulo_members (site_id, user_id, role) VALUES ($1,$2,'owner')`, [site.id, input.ownerId]);
    const required = Object.fromEntries(this.catalog.names().filter((n) => this.catalog.get(n)[0]?.required).map((n) => [n, '*']));
    try {
      await this.applyChange(site.id, { install: { ...required, ...(input.modules ?? {}) } }, { actorId: input.ownerId });
    } catch (e) {
      await this.db.query(`DELETE FROM modulo_sites WHERE id=$1`, [site.id]);
      throw e;
    }
    return this.getSite(site.id);
  }

  async updateSite(siteId: string, patch: { name?: string; domain?: string | null; theme?: Partial<Theme>; settings?: Record<string, unknown> }) {
    const site = await this.getSite(siteId);
    if (patch.domain && !/^[a-z0-9.-]+(:\d+)?$/i.test(patch.domain)) throw new ValidationError('Invalid domain');
    const theme = patch.theme ? { ...site.theme, ...patch.theme } : site.theme;
    await this.db.query(`UPDATE modulo_sites SET name=$2, domain=$3, theme=$4::jsonb, settings=$5::jsonb WHERE id=$1`, [
      siteId,
      patch.name ?? site.name,
      patch.domain === undefined ? site.domain : patch.domain?.toLowerCase() || null,
      JSON.stringify(theme),
      JSON.stringify({ ...site.settings, ...(patch.settings ?? {}) }),
    ]);
    return this.getSite(siteId);
  }

  async deleteSite(siteId: string) {
    await this.db.query(`DELETE FROM modulo_sites WHERE id=$1`, [siteId]);
    this.runtimes.delete(siteId);
  }

  theme(site: SiteInfo): Theme {
    return mergeTheme(defaultTheme, site.theme as any);
  }

  /* ───────────────────────── users / members ───────────────────────── */

  async createUser(input: { email: string; password: string; name?: string; superadmin?: boolean }): Promise<UserRow> {
    return createUser(this.db, input);
  }

  async addMember(siteId: string, userId: string, role: string) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(role)) throw new ValidationError('Invalid role');
    await this.db.query(`INSERT INTO modulo_members (site_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (site_id, user_id) DO UPDATE SET role=EXCLUDED.role`, [
      siteId,
      userId,
      role,
    ]);
  }

  async setRolePermissions(siteId: string, role: string, permissions: string[]) {
    await this.db.query(
      `INSERT INTO modulo_roles (site_id, role, permissions) VALUES ($1,$2,$3) ON CONFLICT (site_id, role) DO UPDATE SET permissions=EXCLUDED.permissions`,
      [siteId, role, permissions],
    );
  }

  async userInfo(siteId: string, userId: string): Promise<UserInfo | null> {
    const r = await this.db.query(
      `SELECT u.id, u.email, u.name, u.is_superadmin, m.role, ro.permissions
       FROM modulo_users u
       LEFT JOIN modulo_members m ON m.user_id = u.id AND m.site_id = $1
       LEFT JOIN modulo_roles ro ON ro.site_id = $1 AND ro.role = m.role
       WHERE u.id = $2`,
      [siteId, userId],
    );
    const u = r.rows[0];
    if (!u) return null;
    const rt = await this.runtime(siteId);
    const permissions = u.role ? rt.permissionsForRole(u.role, u.permissions ?? undefined) : new Set<string>();
    return { id: u.id, email: u.email, name: u.name, isSuperadmin: u.is_superadmin, role: u.role, permissions };
  }

  /* ───────────────────────── runtimes / contexts ───────────────────────── */

  runtime(siteId: string): Promise<SiteRuntime> {
    let p = this.runtimes.get(siteId);
    if (!p) {
      p = this.buildRuntime(siteId);
      this.runtimes.set(siteId, p);
      p.catch(() => this.runtimes.delete(siteId));
    }
    return p;
  }

  invalidate(siteId?: string) {
    if (siteId) this.runtimes.delete(siteId);
    else this.runtimes.clear();
  }

  private async buildRuntime(siteId: string): Promise<SiteRuntime> {
    const site = await this.db.query(`SELECT lock, resolutions FROM modulo_sites WHERE id=$1`, [siteId]);
    if (!site.rows[0]) throw new NotFoundError('Site not found');
    const lock = site.rows[0].lock as Lockfile;
    const settingsRows = (await this.db.query(`SELECT module, settings FROM modulo_site_modules WHERE site_id=$1`, [siteId])).rows;
    const settings = Object.fromEntries(settingsRows.map((r: any) => [r.module, r.settings]));
    const defs = lock.modules.map((m) => {
      const def = this.catalog.get(m.name).find((d) => d.version === m.version);
      if (!def) throw new ModuloError(`Site ${siteId} locks ${m.name}@${m.version}, which is not in the catalog`, 500, 'missing_module');
      return def;
    });
    return new SiteRuntime(defs, settings, site.rows[0].resolutions ?? {});
  }

  async context(siteIdOrSlug: string, userId: string | null = null, opts: { sudo?: boolean; meta?: Record<string, unknown> } = {}): Promise<SiteContext> {
    const site = await this.getSite(siteIdOrSlug);
    const rt = await this.runtime(site.id);
    const user = userId ? await this.userInfo(site.id, userId) : null;
    return new SiteContext(this, rt, site, user, this.db, !!opts.sudo, false, opts.meta ?? {});
  }

  /* ───────────────────────── install / uninstall / upgrade ───────────────────────── */

  private async currentState(siteId: string) {
    const site = await this.db.query(`SELECT lock FROM modulo_sites WHERE id=$1`, [siteId]);
    if (!site.rows[0]) throw new NotFoundError('Site not found');
    const rows = (await this.db.query<{ module: string; version: string; requested: boolean }>(`SELECT module, version, requested FROM modulo_site_modules WHERE site_id=$1`, [siteId])).rows;
    return { lock: site.rows[0].lock as Lockfile, rows };
  }

  async plan(siteId: string, change: ModuleChange): Promise<InstallPlan> {
    const { lock: current, rows } = await this.currentState(siteId);
    const requested: Record<string, string> = Object.fromEntries(rows.filter((r) => r.requested).map((r) => [r.module, '*']));
    for (const [n, range] of Object.entries(change.install ?? {})) requested[n] = range || '*';
    const curDefs = current.modules.map((m) => this.catalog.get(m.name).find((d) => d.version === m.version)).filter(Boolean) as ModuleDefinition[];
    for (const name of change.uninstall ?? []) {
      const def = this.catalog.get(name)[0];
      if (def?.required) throw new ValidationError(`${name} is required and cannot be uninstalled`);
      if (!current.modules.some((m) => m.name === name)) throw new NotFoundError(`${name} is not installed`);
      delete requested[name];
      const blocking = dependents(curDefs, name).filter((d) => requested[d] && !(change.uninstall ?? []).includes(d));
      if (blocking.length && !change.cascade) throw new ConflictError(`Cannot uninstall ${name}: required by ${blocking.join(', ')}`, { dependents: blocking });
      for (const d of blocking) delete requested[d];
    }
    const removing = new Set(change.uninstall ?? []);
    let resolved;
    try {
      resolved = resolve(this.catalog, { requested, current, upgrade: change.upgrade });
    } catch (e) {
      if (e instanceof ResolveError) throw new ValidationError(e.message, e.problems);
      throw e;
    }
    if ([...removing].some((r) => resolved.lock.modules.some((m) => m.name === r))) {
      const still = [...removing].filter((r) => resolved.lock.modules.some((m) => m.name === r));
      throw new ConflictError(`Cannot uninstall ${still.join(', ')}: still required by other installed modules`);
    }
    const before = new Map(current.modules.map((m) => [m.name, m.version]));
    const after = new Map(resolved.lock.modules.map((m) => [m.name, m.version]));
    const runtime = new SiteRuntime(resolved.defs, {}, {});
    const conflicts = runtime.conflicts();
    const patchFailures = runtime
      .templateIds()
      .flatMap(({ id }) => (runtime.template(id)?.failures ?? []).filter((f) => f.reason !== 'lost conflict').map((f) => ({ template: id, ...f })));
    return {
      lock: resolved.lock,
      defs: resolved.defs,
      added: [...after].filter(([n]) => !before.has(n)).map(([name, version]) => ({ name, version })),
      removed: [...before].filter(([n]) => !after.has(n)).map(([name, version]) => ({ name, version })),
      upgraded: [...after].filter(([n, v]) => before.has(n) && before.get(n) !== v).map(([name, to]) => ({ name, from: before.get(name)!, to })),
      conflicts,
      patchFailures,
    };
  }

  /** Apply a module change atomically: schema sync, lifecycle hooks, data migrations, shipped records, lockfile. */
  async applyChange(siteId: string, change: ModuleChange, opts: { actorId?: string } = {}): Promise<InstallReport> {
    const plan = await this.plan(siteId, change);
    const schema = plan.added.length || plan.upgraded.length ? await this.recompose(plan.defs) : null;
    const oldRuntime = await this.runtime(siteId).catch(() => null);
    const site = await this.getSite(siteId);
    const settingsRows = (await this.db.query(`SELECT module, settings FROM modulo_site_modules WHERE site_id=$1`, [siteId])).rows;
    const resolutions = (await this.db.query(`SELECT resolutions FROM modulo_sites WHERE id=$1`, [siteId])).rows[0]?.resolutions ?? {};
    const newRuntime = new SiteRuntime(plan.defs, Object.fromEntries(settingsRows.map((r: any) => [r.module, r.settings])), resolutions);
    const records: Record<string, RecordsReport> = {};
    const requestedNames = new Set([
      ...Object.keys(change.install ?? {}),
      ...(await this.db.query(`SELECT module FROM modulo_site_modules WHERE site_id=$1 AND requested`, [siteId])).rows.map((r: any) => r.module),
    ]);
    (change.uninstall ?? []).forEach((n) => requestedNames.delete(n));

    try {
    await this.db.tx(async (t) => {
      await t.query(`SELECT set_config('app.site_id', $1, true)`, [siteId]);
      await t.exec(`SET LOCAL ROLE ${APP_ROLE}`);
      await runInSiteTx(siteId, t, async () => {
      const actor = opts.actorId ? await this.userInfoTx(t, siteId, opts.actorId) : null;
      // Uninstall in reverse dependency order, with the old runtime (modules still present).
      if (oldRuntime) {
        const oldCtx = new SiteContext(this, oldRuntime, site, actor, t, true, true);
        for (const r of [...plan.removed].reverse()) {
          const def = oldRuntime.defs.find((d) => d.name === r.name);
          await def?.lifecycle?.uninstall?.(oldCtx);
          await t.query(`DELETE FROM modulo_site_modules WHERE site_id=$1 AND module=$2`, [siteId, r.name]);
          await t.query(`DELETE FROM modulo_records WHERE site_id=$1 AND module=$2`, [siteId, r.name]);
        }
      }
      const ctx = new SiteContext(this, newRuntime, site, actor, t, true, true);
      for (const def of plan.defs) {
        const added = plan.added.find((a) => a.name === def.name);
        const up = plan.upgraded.find((u) => u.name === def.name);
        if (!added && !up) continue;
        if (added) {
          await t.query(
            `INSERT INTO modulo_site_modules (site_id, module, version, auto, requested) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (site_id, module) DO UPDATE SET version=EXCLUDED.version`,
            [siteId, def.name, def.version, !!plan.lock.modules.find((m) => m.name === def.name)?.auto, requestedNames.has(def.name)],
          );
          await def.lifecycle?.install?.(ctx);
        } else if (up) {
          const steps = Object.keys(def.migrations ?? {})
            .filter((v) => semver.valid(v) && semver.gt(v, up.from) && semver.lte(v, up.to))
            .sort(semver.compare);
          for (const v of steps) await def.migrations![v]!.data?.(ctx);
          await def.lifecycle?.upgrade?.(ctx, up.from);
          await t.query(`UPDATE modulo_site_modules SET version=$3 WHERE site_id=$1 AND module=$2`, [siteId, def.name, def.version]);
        }
        if (def.records?.length) records[def.name] = await applyShippedRecords(ctx, def);
      }
      for (const name of requestedNames) await t.query(`UPDATE modulo_site_modules SET requested=true WHERE site_id=$1 AND module=$2`, [siteId, name]);
      await t.query(`UPDATE modulo_site_modules SET requested=false WHERE site_id=$1 AND NOT (module = ANY($2))`, [siteId, [...requestedNames]]);
      await t.query(`UPDATE modulo_sites SET lock=$2::jsonb WHERE id=$1`, [siteId, JSON.stringify(plan.lock)]);
      await t.query(`INSERT INTO modulo_audit (site_id, user_id, action, detail) VALUES ($1,$2,'modules.change',$3::jsonb)`, [
        siteId,
        opts.actorId ?? null,
        JSON.stringify({ added: plan.added, removed: plan.removed, upgraded: plan.upgraded }),
      ]);
      });
    });
    } catch (e) {
      // DDL is additive and stays, but the in-memory registry must match what is actually installed.
      if (schema) await this.recompose().catch(() => {});
      throw e;
    }
    this.invalidate(siteId);
    return { ...plan, schema, records };
  }

  private async userInfoTx(t: Db, siteId: string, userId: string): Promise<UserInfo | null> {
    const r = await t.query(`SELECT u.id, u.email, u.name, u.is_superadmin, m.role FROM modulo_users u LEFT JOIN modulo_members m ON m.user_id=u.id AND m.site_id=$1 WHERE u.id=$2`, [
      siteId,
      userId,
    ]);
    const u = r.rows[0];
    return u ? { id: u.id, email: u.email, name: u.name, isSuperadmin: u.is_superadmin, role: u.role, permissions: new Set(['*']) } : null;
  }

  /**
   * Install required modules that sites don't have yet (e.g. a required module added
   * after those sites were created). Returns slug -> installed module names.
   */
  async ensureRequiredModules(): Promise<Record<string, string[]>> {
    const required = this.catalog.names().filter((n) => this.catalog.get(n)[0]?.required);
    const out: Record<string, string[]> = {};
    for (const site of await this.listSites()) {
      const have = new Set((await this.installedModules(site.id)).map((m) => m.name));
      const missing = required.filter((n) => !have.has(n));
      if (!missing.length) continue;
      try {
        await this.applyChange(site.id, { install: Object.fromEntries(missing.map((n) => [n, '*'])) });
        out[site.slug] = missing;
      } catch (e) {
        this.log(`could not install required modules ${missing.join(', ')} on ${site.slug}`, e);
      }
    }
    return out;
  }

  async installedModules(siteId: string) {
    const rows = (await this.db.query(`SELECT module, version, auto, requested, settings, installed_at FROM modulo_site_modules WHERE site_id=$1 ORDER BY installed_at`, [siteId])).rows;
    return rows.map((r: any) => {
      const def = this.catalog.get(r.module).find((d) => d.version === r.version);
      const newest = this.catalog.get(r.module)[0];
      return {
        name: r.module,
        version: r.version,
        auto: r.auto,
        requested: r.requested,
        label: def?.label ?? r.module,
        description: def?.description,
        required: !!def?.required,
        settings: r.settings,
        updateAvailable: newest && semver.gt(newest.version, r.version) ? newest.version : null,
      };
    });
  }

  async updateModuleSettings(siteId: string, module: string, values: Record<string, unknown>) {
    const rt = await this.runtime(siteId);
    const def = rt.defs.find((d) => d.name === module);
    if (!def) throw new NotFoundError(`${module} not installed`);
    const res = fieldsToZod(def.settings ?? {}).safeParse(values);
    if (!res.success) throw new ValidationError(res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const merged = { ...(rt.settings.get(module) ?? {}), ...values };
    await this.db.query(`UPDATE modulo_site_modules SET settings=$3::jsonb WHERE site_id=$1 AND module=$2`, [siteId, module, JSON.stringify(merged)]);
    this.invalidate(siteId);
    return merged;
  }

  /** Choose the winning module for a patch conflict ("target|kind"). */
  async resolveConflict(siteId: string, key: string, module: string) {
    const r = await this.db.query(`SELECT resolutions FROM modulo_sites WHERE id=$1`, [siteId]);
    const res = { ...(r.rows[0]?.resolutions ?? {}), [key]: module };
    await this.db.query(`UPDATE modulo_sites SET resolutions=$2::jsonb WHERE id=$1`, [siteId, JSON.stringify(res)]);
    this.invalidate(siteId);
  }

  /* ───────────────────────── events & jobs ───────────────────────── */

  async addWebhook(siteId: string, url: string, events: string[]) {
    if (!/^https?:\/\//.test(url)) throw new ValidationError('Webhook URL must be http(s)');
    const secret = randomBytes(24).toString('base64url');
    const r = await this.db.query(`INSERT INTO modulo_webhooks (site_id, url, events, secret) VALUES ($1,$2,$3,$4) RETURNING id`, [siteId, url, events, secret]);
    return { id: r.rows[0].id as string, secret };
  }

  /** Process-level listener for every dispatched event (cache invalidation, CDN purge, metrics). */
  onEvent(fn: (siteId: string, event: string, payload: any) => void | Promise<void>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Dispatch pending outbox events to module subscribers and webhooks. Returns number processed. */
  async processOutbox(limit = 50): Promise<number> {
    const rows = (await this.db.query(`SELECT * FROM modulo_outbox WHERE processed_at IS NULL AND attempts < 5 ORDER BY id LIMIT $1`, [limit])).rows;
    for (const ev of rows) {
      try {
        const ctx = await this.context(ev.site_id, null, { sudo: true });
        for (const sub of ctx.runtime.events) {
          if (matchEvent(sub.event, ev.event)) await ctx.tx((c) => Promise.resolve(sub.handler(ev.payload, c)));
        }
        for (const l of this.listeners) {
          try {
            await l(ev.site_id, ev.event, ev.payload);
          } catch (e) {
            this.log('event listener failed', e);
          }
        }
        const hooks = (await this.db.query(`SELECT * FROM modulo_webhooks WHERE site_id=$1`, [ev.site_id])).rows;
        for (const h of hooks) {
          if ((h.events as string[]).some((p) => matchEvent(p, ev.event))) {
            await this.db.query(`INSERT INTO modulo_jobs (site_id, module, name, payload) VALUES ($1,'kernel','webhook',$2::jsonb)`, [
              ev.site_id,
              JSON.stringify({ webhook: h.id, event: ev.event, payload: ev.payload, id: String(ev.id) }),
            ]);
          }
        }
        await this.db.query(`UPDATE modulo_outbox SET processed_at=now(), attempts=attempts+1 WHERE id=$1`, [ev.id]);
      } catch (e: any) {
        this.log(`outbox event ${ev.id} failed`, e);
        await this.db.query(`UPDATE modulo_outbox SET attempts=attempts+1, last_error=$2 WHERE id=$1`, [ev.id, String(e?.message ?? e)]);
      }
    }
    return rows.length;
  }

  /** Run due jobs with exponential backoff. Returns number attempted. */
  async runJobs(limit = 20): Promise<number> {
    const rows = (
      await this.db.query(
        `UPDATE modulo_jobs SET locked_until = now() + interval '5 minutes', attempts = attempts + 1
         WHERE id IN (SELECT id FROM modulo_jobs WHERE status='pending' AND run_at <= now() AND (locked_until IS NULL OR locked_until < now()) ORDER BY run_at LIMIT $1 FOR UPDATE SKIP LOCKED)
         RETURNING *`,
        [limit],
      )
    ).rows;
    for (const job of rows) {
      try {
        if (job.module === 'kernel' && job.name === 'webhook') await this.deliverWebhook(job.payload);
        else {
          const ctx = await this.context(job.site_id, null, { sudo: true });
          const def = ctx.runtime.jobs.get(`${job.module}:${job.name}`);
          if (!def) throw new Error(`No handler for job ${job.module}:${job.name}`);
          await ctx.tx((c) => Promise.resolve(def.handler(job.payload, c)));
        }
        await this.db.query(`UPDATE modulo_jobs SET status='done', locked_until=NULL WHERE id=$1`, [job.id]);
      } catch (e: any) {
        const failed = job.attempts >= job.max_attempts;
        const backoff = Math.min(2 ** job.attempts * 1000, 3_600_000);
        await this.db.query(
          `UPDATE modulo_jobs SET status=$2, last_error=$3, locked_until=NULL, run_at = now() + ($4 || ' milliseconds')::interval WHERE id=$1`,
          [job.id, failed ? 'failed' : 'pending', String(e?.message ?? e), String(backoff)],
        );
      }
    }
    return rows.length;
  }

  private async deliverWebhook(p: { webhook: string; event: string; payload: unknown; id: string }) {
    const h = (await this.db.query(`SELECT * FROM modulo_webhooks WHERE id=$1`, [p.webhook])).rows[0];
    if (!h) return;
    const body = JSON.stringify({ id: p.id, event: p.event, payload: p.payload });
    const sig = createHmac('sha256', h.secret).update(body).digest('hex');
    const res = await fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-modulo-signature': sig, 'x-modulo-event': p.event }, body });
    if (!res.ok) throw new Error(`Webhook ${h.url} responded ${res.status}`);
  }

  /** Drain outbox and jobs until idle (tests / CLI). */
  async drain(maxRounds = 20) {
    for (let i = 0; i < maxRounds; i++) {
      const a = await this.processOutbox();
      const b = await this.runJobs();
      if (!a && !b) return;
    }
  }

  startWorker(intervalMs = 1000) {
    if (this.worker) return;
    this.worker = setInterval(async () => {
      if (this.working) return;
      this.working = true;
      try {
        await this.processOutbox();
        await this.runJobs();
      } catch (e) {
        this.log('worker error', e);
      } finally {
        this.working = false;
      }
    }, intervalMs);
  }

  stopWorker() {
    if (this.worker) clearInterval(this.worker);
    this.worker = null;
  }

  async close() {
    this.stopWorker();
    await this.db.close();
  }
}

export function matchEvent(pattern: string, event: string): boolean {
  if (pattern === '*' || pattern === event) return true;
  if (pattern.endsWith('*')) return event.startsWith(pattern.slice(0, -1));
  return false;
}
