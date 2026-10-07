import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from './db.ts';
import { ForbiddenError, NotFoundError } from './errors.ts';
import type { HookBus } from './hooks.ts';
import { Repository } from './repo.ts';
import type { SiteRuntime } from './runtime.ts';
import type { Kernel } from './kernel.ts';
import { APP_ROLE } from './system.ts';

export interface SiteInfo {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  theme: Record<string, Record<string, string>>;
  settings: Record<string, unknown>;
  plan: string;
}

export interface UserInfo {
  id: string;
  email: string;
  name: string;
  isSuperadmin: boolean;
  /** Role on the current site (null when not a member). */
  role: string | null;
  permissions: Set<string>;
}

/** The site transaction active in the current async call chain (if any). */
const activeTx = new AsyncLocalStorage<{ siteId: string; db: Db }>();

/**
 * Everything a module sees: the site, the acting user, a transaction-bound
 * database handle, repositories, services, hooks, events and jobs.
 */
export function runInSiteTx<T>(siteId: string, db: Db, fn: () => Promise<T>): Promise<T> {
  return activeTx.run({ siteId, db }, fn);
}

export class SiteContext {
  constructor(
    readonly kernel: Kernel,
    readonly runtime: SiteRuntime,
    readonly site: SiteInfo,
    readonly user: UserInfo | null,
    readonly db: Db,
    readonly sudo = false,
    readonly inSiteTx = false,
    /** Free-form request metadata (ip, locale, cart id...). */
    readonly meta: Record<string, unknown> = {},
  ) {}

  get hooks(): HookBus {
    return this.runtime.hooks;
  }

  can(permission: string): boolean {
    if (this.sudo) return true;
    if (!this.user) return permission === 'public';
    if (this.user.isSuperadmin) return true;
    const p = this.user.permissions;
    if (p.has('*') || p.has(permission)) return true;
    const mod = permission.split('.')[0];
    return p.has(`${mod}.*`);
  }

  require(permission: string) {
    if (!this.can(permission)) throw new ForbiddenError(`Missing permission "${permission}"`);
  }

  repo(model: string): Repository {
    const m = this.kernel.models.get(model);
    if (!m || !this.runtime.installed.has(m.module)) throw new NotFoundError(`Model ${model} is not available on this site`);
    return new Repository(this, m);
  }

  service<T = Record<string, (...args: any[]) => any>>(module: string): T {
    const factory = this.runtime.services.get(module);
    if (!factory) throw new NotFoundError(`Module ${module} is not installed or exposes no services`);
    return factory(this) as T;
  }

  hasModule(name: string) {
    return this.runtime.installed.has(name);
  }

  settings(module: string): Record<string, any> {
    return this.runtime.settings.get(module) ?? {};
  }

  asSudo(): SiteContext {
    return new SiteContext(this.kernel, this.runtime, this.site, this.user, this.db, true, this.inSiteTx, this.meta);
  }

  withMeta(meta: Record<string, unknown>): SiteContext {
    return new SiteContext(this.kernel, this.runtime, this.site, this.user, this.db, this.sudo, this.inSiteTx, { ...this.meta, ...meta });
  }

  /** Run fn in a transaction with RLS bound to this site. Nested calls reuse it. */
  async tx<T>(fn: (ctx: SiteContext) => Promise<T>): Promise<T> {
    if (this.inSiteTx) return fn(this);
    // A context created outside the transaction but used inside it (e.g. a captured ctx in a
    // service) joins the open transaction instead of deadlocking on a second connection.
    const active = activeTx.getStore();
    if (active) {
      if (active.siteId !== this.site.id) throw new Error(`Cannot open a transaction for site ${this.site.slug} inside another site's transaction`);
      return fn(new SiteContext(this.kernel, this.runtime, this.site, this.user, active.db, this.sudo, true, this.meta));
    }
    return this.kernel.db.tx(async (t) => {
      await t.query(`SELECT set_config('app.site_id', $1, true)`, [this.site.id]);
      await t.exec(`SET LOCAL ROLE ${APP_ROLE}`);
      return activeTx.run({ siteId: this.site.id, db: t }, () => fn(new SiteContext(this.kernel, this.runtime, this.site, this.user, t, this.sudo, true, this.meta)));
    });
  }

  /** Transactional outbox: the event is dispatched only if the transaction commits. */
  async emit(event: string, payload: Record<string, unknown> = {}) {
    await this.db.query(`INSERT INTO modulo_outbox (site_id, event, payload) VALUES ($1, $2, $3::jsonb)`, [this.site.id, event, JSON.stringify(payload)]);
  }

  async enqueue(module: string, name: string, payload: Record<string, unknown> = {}, opts: { delayMs?: number; maxAttempts?: number } = {}) {
    await this.db.query(
      `INSERT INTO modulo_jobs (site_id, module, name, payload, run_at, max_attempts) VALUES ($1, $2, $3, $4::jsonb, now() + ($5 || ' milliseconds')::interval, $6)`,
      [this.site.id, module, name, JSON.stringify(payload), String(opts.delayMs ?? 0), opts.maxAttempts ?? 5],
    );
  }

  async audit(action: string, detail: Record<string, unknown> = {}) {
    await this.db.query(`INSERT INTO modulo_audit (site_id, user_id, action, detail) VALUES ($1, $2, $3, $4::jsonb)`, [
      this.site.id,
      this.user?.id ?? null,
      action,
      JSON.stringify(detail),
    ]);
  }
}
