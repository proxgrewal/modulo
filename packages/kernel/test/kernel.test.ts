import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { defineModel, extendModel, mf } from '@modulo/core';
import {
  createPgDb,
  createPgliteDb,
  defineModule,
  HookBus,
  HookChainError,
  Kernel,
  MapCatalog,
  resolve,
  ResolveError,
  APP_ROLE,
  type ModuleDefinition,
} from '../src/index.ts';

const base = defineModule({
  name: 'base',
  version: '1.0.0',
  kernel: '^1.0.0',
  required: true,
  models: [
    defineModel({
      name: 'base.partner',
      titleField: 'name',
      fields: { name: mf.string({ required: true }), email: mf.email(), slug: mf.slug('name') },
      computed: { display: { kind: 'string', depends: ['name', 'email'], compute: (r) => `${r.name} <${r.email ?? ''}>`, stored: true } },
      access: { read: 'public' },
    }),
  ],
});

const loyalty = (version = '1.0.0', extra: Partial<ModuleDefinition> = {}) =>
  defineModule({
    name: 'loyalty',
    version,
    kernel: '^1.0.0',
    depends: { base: '^1.0.0' },
    extendModels: [extendModel({ model: 'base.partner', fields: { points: mf.int({ default: 0 }) } })],
    records: [{ key: 'vip', model: 'base.partner', values: { name: 'VIP Member', email: version === '1.0.0' ? 'vip@x.io' : 'vip@new.io', points: version === '1.0.0' ? 100 : 500 } }],
    ...extra,
  });

let kernel: Kernel;
/** PGlite by default; set TEST_DATABASE_URL to run the same suite against real PostgreSQL. */
async function freshDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return createPgliteDb();
  const db = await createPgDb(url);
  await db.exec('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  return db;
}
async function boot(modules: ModuleDefinition[]) {
  kernel = await Kernel.create({ db: await freshDb(), modules });
  return kernel;
}
afterEach(async () => {
  await kernel?.close();
});

describe('resolver', () => {
  const m = (name: string, version: string, depends: Record<string, string> = {}, more: Partial<ModuleDefinition> = {}) =>
    defineModule({ name, version, kernel: '^1.0.0', depends, ...more });

  it('picks newest satisfying versions in dependency order', () => {
    const cat = new MapCatalog([m('a', '1.0.0'), m('a', '1.2.0'), m('a', '2.0.0'), m('b', '1.0.0', { a: '^1.0.0' })]);
    const { lock } = resolve(cat, { requested: { b: '*' } });
    expect(lock.modules).toEqual([
      { name: 'a', version: '1.2.0' },
      { name: 'b', version: '1.0.0' },
    ]);
  });

  it('keeps pinned versions unless upgraded', () => {
    const cat = new MapCatalog([m('a', '1.0.0'), m('a', '1.1.0')]);
    const current = { kernel: '1.0.0', modules: [{ name: 'a', version: '1.0.0' }] };
    expect(resolve(cat, { requested: { a: '*' }, current }).lock.modules[0]!.version).toBe('1.0.0');
    expect(resolve(cat, { requested: { a: '*' }, current, upgrade: ['a'] }).lock.modules[0]!.version).toBe('1.1.0');
  });

  it('reports unsatisfiable ranges, missing modules, kernel incompatibility and cycles', () => {
    const cat = new MapCatalog([m('a', '1.0.0'), m('b', '1.0.0', { a: '^2.0.0' }), m('c', '1.0.0', { zzz: '*' }), defineModule({ name: 'old', version: '1.0.0', kernel: '^0.9.0' })]);
    expect(() => resolve(cat, { requested: { b: '*' } })).toThrow(/no version satisfies \^2\.0\.0/);
    expect(() => resolve(cat, { requested: { c: '*' } })).toThrow(/zzz: not found/);
    expect(() => resolve(cat, { requested: { old: '*' } })).toThrow(/kernel/);
    const cyc = new MapCatalog([m('x', '1.0.0', { y: '*' }), m('y', '1.0.0', { x: '*' })]);
    expect(() => resolve(cyc, { requested: { x: '*' } })).toThrow(ResolveError);
  });

  it('auto-activates glue modules when all triggers are present', () => {
    const cat = new MapCatalog([m('shop', '1.0.0'), m('blog', '1.0.0'), m('shop-blog', '1.0.0', { shop: '*', blog: '*' }, { activatesWhen: ['shop', 'blog'] })]);
    expect(resolve(cat, { requested: { shop: '*' } }).lock.modules.map((x) => x.name)).toEqual(['shop']);
    const both = resolve(cat, { requested: { shop: '*', blog: '*' } }).lock.modules;
    expect(both.find((x) => x.name === 'shop-blog')).toEqual({ name: 'shop-blog', version: '1.0.0', auto: true });
  });
});

describe('embedded database safety', () => {
  it('refuses a second open of the same PGlite directory and releases the lock on close', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = join(mkdtempSync(join(tmpdir(), 'modulo-lock-')), 'db');
    const a = await createPgliteDb(dir);
    await expect(createPgliteDb(dir)).rejects.toThrow(/already open by process/);
    await a.close();
    const b = await createPgliteDb(dir);
    await b.close();
    rmSync(join(dir, '..'), { recursive: true, force: true });
  });
});

describe('hook bus', () => {
  it('orders handlers by before/after and runs filters', async () => {
    const bus = new HookBus();
    bus.register({ hook: 'title', kind: 'filter', id: 'a', fn: (v: string) => v + 'A' }, 'm1');
    bus.register({ hook: 'title', kind: 'filter', id: 'b', before: ['m1.a'], fn: (v: string) => v + 'B' }, 'm2');
    bus.register({ hook: 'title', kind: 'filter', id: 'c', after: ['m1'], fn: (v: string) => v + 'C' }, 'm3');
    expect(await bus.filter('title', '')).toBe('BAC');
  });

  it('around hooks must call next() unless terminal', async () => {
    const bus = new HookBus();
    bus.register({ hook: 'op', kind: 'around', fn: async (a: number, next: any) => (await next(a + 1)) * 2 }, 'm1');
    expect(await bus.around('op', 1, async (a) => a * 10)).toBe(40);
    bus.register({ hook: 'op', kind: 'around', id: 'bad', fn: async () => 0 }, 'm2');
    await expect(bus.around('op', 1, async (a) => a)).rejects.toThrow(HookChainError);
    const bus2 = new HookBus();
    bus2.register({ hook: 'op', kind: 'around', terminal: true, fn: async () => 'cached' }, 'cache');
    expect(await bus2.around('op', 1, async () => 'core')).toBe('cached');
  });
});

describe('kernel: schema, repositories, tenancy', () => {
  it('creates tables, validates, fills slugs and stored computed fields', async () => {
    await boot([base]);
    const site = await kernel.createSite({ slug: 'acme', name: 'Acme' });
    const ctx = await kernel.context(site.id, null, { sudo: true });
    const p = await ctx.repo('base.partner').create({ name: 'Ada Lovelace', email: 'ada@x.io' });
    expect(p.slug).toBe('ada-lovelace');
    expect(p.display).toBe('Ada Lovelace <ada@x.io>');
    const p2 = await ctx.repo('base.partner').create({ name: 'Ada Lovelace' });
    expect(p2.slug).toBe('ada-lovelace-2');
    const up = await ctx.repo('base.partner').update(p.id, { email: 'ada@new.io' });
    expect(up.display).toBe('Ada Lovelace <ada@new.io>');
    await expect(ctx.repo('base.partner').create({ email: 'not-an-email', name: 'x' })).rejects.toThrow(/Invalid base.partner/);
    await expect(ctx.repo('base.partner').create({ name: 'x', bogus: 1 })).rejects.toThrow();
    expect(await ctx.repo('base.partner').count({ name: { ilike: 'ada%' } })).toBe(2);
  });

  it('joins the open transaction when a captured outer context is used inside it (no deadlock)', async () => {
    await boot([base]);
    const site = await kernel.createSite({ slug: 'nest', name: 'Nest' });
    const outer = await kernel.context(site.id, null, { sudo: true });
    await expect(
      outer.tx(async (inner) => {
        await inner.repo('base.partner').create({ name: 'inner' });
        await outer.repo('base.partner').create({ name: 'captured outer' }); // would deadlock without joining
        throw new Error('rollback both');
      }),
    ).rejects.toThrow('rollback both');
    expect(await outer.repo('base.partner').count()).toBe(0);
  });

  it('isolates sites with row-level security', async () => {
    await boot([base]);
    const a = await kernel.createSite({ slug: 'a', name: 'A' });
    const b = await kernel.createSite({ slug: 'b', name: 'B' });
    await (await kernel.context(a.id, null, { sudo: true })).repo('base.partner').create({ name: 'Only in A' });
    const fromB = await (await kernel.context(b.id, null, { sudo: true })).repo('base.partner').find();
    expect(fromB).toHaveLength(0);
    // Even a raw query without a site filter sees nothing under the app role for another site.
    const leaked = await kernel.db.tx(async (t) => {
      await t.query(`SELECT set_config('app.site_id', $1, true)`, [b.id]);
      await t.exec(`SET LOCAL ROLE ${APP_ROLE}`);
      return (await t.query(`SELECT * FROM m_base__partner`)).rows;
    });
    expect(leaked).toHaveLength(0);
  });

  it('enforces access rules for anonymous and permissioned users', async () => {
    await boot([base]);
    const site = await kernel.createSite({ slug: 's', name: 'S' });
    const anon = await kernel.context(site.id, null);
    expect(await anon.repo('base.partner').find()).toEqual([]);
    await expect(anon.repo('base.partner').create({ name: 'x' })).rejects.toThrow(/Sign in/);
    const u = await kernel.createUser({ email: 'ed@x.io', password: 'password1' });
    await kernel.addMember(site.id, u.id, 'editor');
    const ed = await kernel.context(site.id, u.id);
    await expect(ed.repo('base.partner').create({ name: 'x' })).rejects.toThrow(/base.manage/);
    await kernel.setRolePermissions(site.id, 'editor', ['base.manage']);
    expect((await (await kernel.context(site.id, u.id)).repo('base.partner').create({ name: 'x' })).name).toBe('x');
  });
});

describe('kernel: modules', () => {
  it('extension fields are visible only where the extending module is installed', async () => {
    await boot([base, loyalty()]);
    const withL = await kernel.createSite({ slug: 'l', name: 'L', modules: { loyalty: '*' } });
    const without = await kernel.createSite({ slug: 'n', name: 'N' });
    const c1 = await kernel.context(withL.id, null, { sudo: true });
    const c2 = await kernel.context(without.id, null, { sudo: true });
    expect((await c1.repo('base.partner').create({ name: 'a', points: 5 })).points).toBe(5);
    await expect(c2.repo('base.partner').create({ name: 'a', points: 5 })).rejects.toThrow();
    expect('points' in (await c2.repo('base.partner').create({ name: 'b' }))).toBe(false);
  });

  it('three-way merges shipped records on upgrade', async () => {
    await boot([base, loyalty('1.0.0'), loyalty('1.1.0')]);
    const site = await kernel.createSite({ slug: 'm', name: 'M', modules: { loyalty: '1.0.0' } });
    const ctx = await kernel.context(site.id, null, { sudo: true });
    const vip = (await ctx.repo('base.partner').findOne({ name: 'VIP Member' }))!;
    expect(vip.points).toBe(100);
    // User edits points; email untouched.
    await ctx.repo('base.partner').update(vip.id, { points: 42 });
    const report = await kernel.applyChange(site.id, { install: { loyalty: '^1.1.0' } });
    expect(report.upgraded).toEqual([{ name: 'loyalty', from: '1.0.0', to: '1.1.0' }]);
    const after = await (await kernel.context(site.id, null, { sudo: true })).repo('base.partner').get(vip.id);
    expect(after.email).toBe('vip@new.io'); // upstream change applied
    expect(after.points).toBe(42); // user change kept
    expect(report.records.loyalty!.conflicts).toEqual([{ key: 'vip', field: 'points', kept: 42, shipped: 500 }]);
  });

  it('rolls back the whole install when a lifecycle hook fails', async () => {
    const broken = defineModule({
      name: 'broken',
      version: '1.0.0',
      kernel: '^1.0.0',
      depends: { base: '*' },
      lifecycle: {
        install: async (ctx) => {
          await ctx.repo('base.partner').create({ name: 'should vanish' });
          throw new Error('boom');
        },
      },
    });
    await boot([base, broken]);
    const site = await kernel.createSite({ slug: 'r', name: 'R' });
    await expect(kernel.applyChange(site.id, { install: { broken: '*' } })).rejects.toThrow('boom');
    const ctx = await kernel.context(site.id, null, { sudo: true });
    expect(await ctx.repo('base.partner').count()).toBe(0);
    expect((await kernel.installedModules(site.id)).map((m) => m.name)).toEqual(['base']);
  });

  it('refuses to uninstall a module others depend on, unless cascading; removes orphaned deps', async () => {
    const lib = defineModule({ name: 'lib', version: '1.0.0', kernel: '^1.0.0' });
    const app = defineModule({ name: 'app', version: '1.0.0', kernel: '^1.0.0', depends: { lib: '*' } });
    await boot([base, lib, app]);
    const site = await kernel.createSite({ slug: 'u', name: 'U', modules: { app: '*', lib: '*' } });
    await expect(kernel.applyChange(site.id, { uninstall: ['lib'] })).rejects.toThrow(/required by app/);
    const rep = await kernel.applyChange(site.id, { uninstall: ['lib'], cascade: true });
    expect(rep.removed.map((r) => r.name).sort()).toEqual(['app', 'lib']);
    await expect(kernel.applyChange(site.id, { uninstall: ['base'] })).rejects.toThrow(/required/);
  });

  it('installs a newly required module on existing sites', async () => {
    const extra = defineModule({ name: 'extra', version: '1.0.0', kernel: '^1.0.0', required: true });
    await boot([base]);
    const site = await kernel.createSite({ slug: 'old', name: 'Old' });
    kernel.catalog.add(extra); // a required module shipped after the site existed
    expect(await kernel.ensureRequiredModules()).toEqual({ old: ['extra'] });
    expect((await kernel.installedModules(site.id)).map((m) => m.name).sort()).toEqual(['base', 'extra']);
    expect(await kernel.ensureRequiredModules()).toEqual({});
  });

  it('dispatches outbox events to subscribers only after commit', async () => {
    const seen: string[] = [];
    const audit = defineModule({
      name: 'audit',
      version: '1.0.0',
      kernel: '^1.0.0',
      depends: { base: '*' },
      events: [{ event: 'base.partner.*', handler: (p, ctx) => void seen.push(`${ctx.site.slug}:${p.id}`) }],
      jobs: [{ name: 'noop', handler: () => {} }],
    });
    await boot([base, audit]);
    const site = await kernel.createSite({ slug: 'e', name: 'E', modules: { audit: '*' } });
    const ctx = await kernel.context(site.id, null, { sudo: true });
    const p = await ctx.repo('base.partner').create({ name: 'Grace' });
    await expect(ctx.tx(async (c) => {
      await c.repo('base.partner').create({ name: 'Rolled back' });
      throw new Error('abort');
    })).rejects.toThrow('abort');
    await ctx.tx((c) => c.enqueue('audit', 'noop'));
    await kernel.drain();
    expect(seen).toEqual([`e:${p.id}`]);
    const jobs = (await kernel.db.query(`SELECT status FROM modulo_jobs`)).rows;
    expect(jobs).toEqual([{ status: 'done' }]);
  });

  it('runs schema migrations between versions', async () => {
    const v1 = defineModule({ name: 'notes', version: '1.0.0', kernel: '^1.0.0', models: [defineModel({ name: 'notes.note', fields: { body: mf.text() } })] });
    const v2 = defineModule({
      name: 'notes',
      version: '2.0.0',
      kernel: '^1.0.0',
      models: [defineModel({ name: 'notes.note', fields: { content: mf.text() } })],
      migrations: { '2.0.0': { schema: async (db) => db.exec(`ALTER TABLE m_notes__note RENAME COLUMN body TO content`) } },
    });
    await boot([base, v1, v2]);
    const site = await kernel.createSite({ slug: 'mg', name: 'MG', modules: { notes: '1.0.0' } });
    await (await kernel.context(site.id, null, { sudo: true })).repo('notes.note').create({ body: 'hello' });
    await kernel.applyChange(site.id, { install: { notes: '^2.0.0' } });
    const notes = await (await kernel.context(site.id, null, { sudo: true })).repo('notes.note').find();
    expect(notes[0]!.content).toBe('hello');
  });
});
