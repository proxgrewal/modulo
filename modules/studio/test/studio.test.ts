import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineModel, mf } from '@modulo/core';
import { createPgliteDb, defineModule, invokeRoute, Kernel, type ModuleDefinition, type SiteContext } from '@modulo/kernel';
import studio, { localModuleName, onKernelBoot, validateDefinition, buildModule, renameModule, unpackOrder } from '../src/index.ts';

const crm = defineModule({
  name: 'crm',
  version: '1.2.0',
  kernel: '^1.0.0',
  models: [defineModel({ name: 'crm.contact', titleField: 'name', fields: { name: mf.string({ required: true }) } })],
});

const eventsDef = {
  models: [
    {
      name: 'events.venue',
      label: 'Venue',
      titleField: 'name',
      fields: { name: { kind: 'string', required: true }, capacity: { kind: 'int' } },
    },
    {
      name: 'events.event',
      label: 'Event',
      titleField: 'title',
      fields: {
        title: { kind: 'string', required: true, label: 'Title' },
        slug: { kind: 'slug', from: 'title' },
        kind: { kind: 'enum', options: ['talk', 'workshop'], default: 'talk' },
        venue: { kind: 'ref', model: 'events.venue' },
        host: { kind: 'ref', model: 'crm.contact', onDelete: 'restrict' },
        starts_at: { kind: 'datetime' },
        published: { kind: 'boolean' },
      },
      access: { read: 'public' },
      order: 'starts_at desc',
    },
  ],
  extendModels: [{ model: 'crm.contact', fields: { speaker_bio: { kind: 'text' } } }],
  permissions: [{ key: 'events.manage', label: 'Manage events' }],
  grants: { editor: ['events.manage'] },
  editor: { collections: [{ model: 'events.event', label: 'Events' }] },
};

let kernels: Kernel[] = [];
const tmpDirs: string[] = [];
afterEach(async () => {
  for (const k of kernels) await k.close().catch(() => {});
  kernels = [];
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(dataDir?: string, modules: ModuleDefinition[] = [studio, crm]) {
  const k = await Kernel.create({ db: await createPgliteDb(dataDir), modules });
  kernels.push(k);
  return k;
}

const call = (ctx: SiteContext, method: string, path: string, body?: unknown, query?: Record<string, string>) =>
  invokeRoute(ctx, { module: 'studio', method, path, body, query }).then((r) => r.body as any);

async function setup(dataDir?: string) {
  const kernel = await boot(dataDir);
  const site = await kernel.createSite({ slug: 'acme', name: 'Acme', modules: { studio: '*', crm: '*' } });
  const ctx = await kernel.context(site.id, null, { sudo: true });
  return { kernel, site, ctx };
}

describe('definition validation', () => {
  const env = (extra: Partial<Parameters<typeof validateDefinition>[1]> = {}) => ({
    localName: 'events',
    moduleName: 'x_abcdef12_events',
    siteModels: new Map([['crm.contact', { module: 'crm', fields: { name: { kind: 'string', module: 'crm' } } }]]),
    ...extra,
  });

  it('accepts a well-formed definition', () => {
    const res = validateDefinition(eventsDef, env());
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('rejects bad names, reserved fields, unknown refs, empty enums and code', () => {
    const bad = {
      models: [
        {
          name: 'other.thing',
          fields: {
            id: { kind: 'string' },
            Bad: { kind: 'string' },
            kind: { kind: 'enum', options: [] },
            link: { kind: 'ref', model: 'nope.model' },
          },
        },
      ],
    };
    const res = validateDefinition(bad, env());
    expect(res.ok).toBe(false);
    const text = res.problems.join('\n');
    expect(text).toMatch(/reserved/);
    expect(text).toMatch(/invalid field name "Bad"/);
    expect(text).toMatch(/at least one option/);

    const sem = validateDefinition({ models: [{ name: 'other.thing', fields: { link: { kind: 'ref', model: 'nope.model' } } }] }, env());
    expect(sem.problems.join('\n')).toMatch(/namespaced "events.<name>"/);
    expect(sem.problems.join('\n')).toMatch(/ref target nope.model does not exist/);

    // Computed functions / unknown keys are not allowed (declarative only).
    const code = validateDefinition({ models: [{ name: 'events.e', fields: { a: { kind: 'string' } }, computed: { x: {} } }] }, env());
    expect(code.ok).toBe(false);
    const ext = validateDefinition({ extendModels: [{ model: 'crm.contact', fields: { name: { kind: 'string' } } }] }, env());
    expect(ext.problems.join('\n')).toMatch(/already exists on crm.contact/);
    const missing = validateDefinition({ extendModels: [{ model: 'shop.product', fields: { x: { kind: 'string' } } }] }, env());
    expect(missing.problems.join('\n')).toMatch(/not installed/);
    const dflt = validateDefinition({ models: [{ name: 'events.e', fields: { k: { kind: 'enum', options: ['a'], default: 'b' } } }] }, env());
    expect(dflt.problems.join('\n')).toMatch(/invalid default/);
  });

  it('builds a namespaced module definition and renames it', () => {
    const res = validateDefinition(eventsDef, env());
    const built = buildModule({ moduleName: 'x_abcdef12_events', localName: 'events', version: '1.0.0', label: 'Events', definition: res.definition! });
    expect(built.models!.map((m) => m.name)).toEqual(['x_abcdef12_events.venue', 'x_abcdef12_events.event']);
    expect(built.models![1]!.fields.venue!.model).toBe('x_abcdef12_events.venue');
    expect(built.models![1]!.fields.host!.model).toBe('crm.contact');
    expect(built.permissions![0]!.key).toBe('x_abcdef12_events.manage');
    const renamed = renameModule(built, 'events');
    expect(renamed.models![1]!.name).toBe('events.event');
    expect(renamed.models![1]!.fields.venue!.model).toBe('events.venue');
    expect(renamed.grants).toEqual({ editor: ['events.manage'] });
  });
});

describe('studio routes', () => {
  it('creates, publishes and evolves a local module', async () => {
    const { kernel, site, ctx } = await setup();
    const kinds = await call(ctx, 'GET', '/field-kinds');
    expect(kinds.kinds.map((k: any) => k.kind)).toContain('ref');

    await expect(call(ctx, 'POST', '/modules', { name: 'Bad Name' })).rejects.toThrow(/name must match/);
    const created = await call(ctx, 'POST', '/modules', { name: 'events', label: 'Events', definition: eventsDef });
    expect(created.module).toBe(localModuleName(site.id, 'events'));
    await expect(call(ctx, 'POST', '/modules', { name: 'events', label: 'Dup' })).rejects.toThrow();
    await expect(call(ctx, 'PUT', `/modules/${created.id}`, { definition: { models: [{ name: 'events.x', fields: { y: { kind: 'ref', model: 'zzz.q' } } }] } })).rejects.toThrow(
      /does not exist/,
    );

    const pub = await call(ctx, 'POST', `/modules/${created.id}/publish`);
    const mod = created.module as string;
    expect(pub.version).toBe('1.0.0');
    expect(pub.added).toEqual([{ name: mod, version: '1.0.0' }]);
    expect(pub.depends).toEqual({ crm: '^1.2.0' });
    expect(pub.schema.createdTables).toContain(`m_${mod}__event`);
    expect(pub.retainedColumns).toEqual([]);

    // The generated models are real: repositories, refs, extension fields, slugs.
    let c = await kernel.context(site.id, null, { sudo: true });
    const host = await c.repo('crm.contact').create({ name: 'Ada', speaker_bio: 'Pioneer' });
    const venue = await c.repo(`${mod}.venue`).create({ name: 'Main hall', capacity: 200 });
    const ev = await c.repo(`${mod}.event`).create({ title: 'Hello World', venue: venue.id, host: host.id });
    expect(ev.slug).toBe('hello-world');
    expect(ev.kind).toBe('talk');
    expect(c.runtime.permissions.some((p: any) => p.key === `${mod}.manage`)).toBe(true);

    // Add a field → new patch version, kernel upgrades and adds the column.
    const def2 = structuredClone(eventsDef) as any;
    def2.models[1].fields.price = { kind: 'money' };
    delete def2.models[0].fields.capacity;
    const upd = await call(ctx, 'PUT', `/modules/${created.id}`, { definition: def2 });
    expect(upd.status).toBe('draft');
    const pub2 = await call(ctx, 'POST', `/modules/${created.id}/publish`);
    expect(pub2.version).toBe('1.0.1');
    expect(pub2.upgraded).toEqual([{ name: mod, from: '1.0.0', to: '1.0.1' }]);
    expect(pub2.schema.addedColumns).toContain(`m_${mod}__event.price`);
    expect(pub2.retainedColumns).toEqual([`m_${mod}__venue.capacity`]);

    c = await kernel.context(site.id, null, { sudo: true });
    const ev2 = await c.repo(`${mod}.event`).update(ev.id, { price: 12.5 });
    expect(ev2.price).toBe(12.5);
    expect(ev2.title).toBe('Hello World');
    const cols = (await kernel.db.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [`m_${mod}__venue`])).rows.map((r) => r.column_name);
    expect(cols).toContain('capacity'); // never dropped

    // Changing a column type is refused.
    const def3 = structuredClone(def2);
    def3.models[1].fields.price = { kind: 'string' };
    await call(ctx, 'PUT', `/modules/${created.id}`, { definition: def3 });
    await expect(call(ctx, 'POST', `/modules/${created.id}/publish`)).rejects.toThrow(/changing the field type/);

    const list = await call(ctx, 'GET', '/modules');
    expect(list).toHaveLength(1);
    expect(list[0].versions).toEqual(['1.0.0', '1.0.1']);
    expect(list[0].published_version).toBe('1.0.1');

    // Direct writes through the generic collection editor cannot forge version bookkeeping.
    await c.repo('studio.local_module').update(created.id, { versions: { '9.9.9': {} }, published_version: '9.9.9' });
    const after = await c.repo('studio.local_module').get(created.id);
    expect(after.published_version).toBe('1.0.1');

    // Delete uninstalls the generated module.
    const del = await call(ctx, 'DELETE', `/modules/${created.id}`);
    expect(del.uninstalled).toBe(true);
    expect((await kernel.installedModules(site.id)).map((m) => m.name)).not.toContain(mod);
    expect(await call(ctx, 'GET', '/modules')).toEqual([]);
  });

  it('requires studio.manage', async () => {
    const { kernel, site } = await setup();
    const u = await kernel.createUser({ email: 'ed@x.io', password: 'password1' });
    await kernel.addMember(site.id, u.id, 'editor');
    const ed = await kernel.context(site.id, u.id);
    await expect(call(ed, 'GET', '/modules')).rejects.toThrow(/studio.manage/);
    const owner = await kernel.createUser({ email: 'own@x.io', password: 'password1' });
    await kernel.addMember(site.id, owner.id, 'owner');
    const oc = await kernel.context(site.id, owner.id);
    const created = await call(oc, 'POST', '/modules', { name: 'notes', definition: { models: [{ name: 'notes.note', fields: { body: { kind: 'text' } } }] } });
    const pub = await call(oc, 'POST', `/modules/${created.id}/publish`);
    expect(pub.version).toBe('1.0.0');
  });

  it('keeps local modules working after a restart (onKernelBoot)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'modulo-studio-'));
    tmpDirs.push(dir);
    const a = await setup(dir);
    const created = await call(a.ctx, 'POST', '/modules', { name: 'events', label: 'Events', definition: eventsDef });
    await call(a.ctx, 'POST', `/modules/${created.id}/publish`);
    const def2 = structuredClone(eventsDef) as any;
    def2.models[0].fields.city = { kind: 'string' };
    await call(a.ctx, 'PUT', `/modules/${created.id}`, { definition: def2 });
    await call(a.ctx, 'POST', `/modules/${created.id}/publish`);
    const mod = created.module as string;
    const c1 = await a.kernel.context(a.site.id, null, { sudo: true });
    await c1.repo(`${mod}.venue`).create({ name: 'Hall', city: 'Paris' });
    await a.kernel.close();
    kernels = [];

    // Without the boot hook the site cannot build its runtime.
    const bare = await boot(dir);
    await expect(bare.context(a.site.id, null, { sudo: true })).rejects.toThrow(/not in the catalog/);
    await bare.close();
    kernels = [];

    const b = await boot(dir);
    await onKernelBoot(b);
    expect(b.catalog.get(mod).map((d) => d.version)).toEqual(['1.0.1', '1.0.0']);
    const c2 = await b.context(a.site.id, null, { sudo: true });
    const venues = await c2.repo(`${mod}.venue`).find();
    expect(venues.map((v) => [v.name, v.city])).toEqual([['Hall', 'Paris']]);
    // And it can keep evolving.
    const ctxB = await b.context(a.site.id, null, { sudo: true });
    def2.models[0].fields.country = { kind: 'string' };
    await call(ctxB, 'PUT', `/modules/${created.id}`, { definition: def2 });
    expect((await call(ctxB, 'POST', `/modules/${created.id}/publish`)).version).toBe('1.0.2');
  });
});

describe('export', () => {
  it('generates a standalone module package that boots', async () => {
    const { ctx } = await setup();
    const standalone = {
      models: [
        {
          name: 'events.venue',
          label: 'Venue',
          titleField: 'name',
          fields: { name: { kind: 'string', required: true }, capacity: { kind: 'int' } },
        },
        {
          name: 'events.event',
          label: "Event's",
          fields: {
            title: { kind: 'string', required: true, max: 120 },
            slug: { kind: 'slug', from: 'title' },
            kind: { kind: 'enum', options: ['talk', 'workshop'], required: true },
            venue: { kind: 'ref', model: 'events.venue', onDelete: 'cascade' },
            featured: { kind: 'boolean', default: true },
          },
          access: { read: 'public' },
        },
      ],
      permissions: [{ key: 'events.manage', label: 'Manage events' }],
      grants: { editor: ['events.manage'] },
      editor: { collections: [{ model: 'events.event', label: 'Events' }] },
    };
    const created = await call(ctx, 'POST', '/modules', { name: 'events', label: 'Events', description: 'Conference events', definition: standalone });
    await call(ctx, 'POST', `/modules/${created.id}/publish`);
    const out = await call(ctx, 'GET', `/modules/${created.id}/export`, undefined, { rename: 'events' });
    expect(out.name).toBe('events');
    expect(Object.keys(out.files).sort()).toEqual(['README.md', 'package.json', 'src/index.ts', 'test/module.test.ts']);
    const src: string = out.files['src/index.ts'];
    expect(src).toContain(`import { defineModule } from '@modulo/kernel';`);
    expect(src).toContain(`title: mf.string({ required: true, max: 120 }),`);
    expect(src.indexOf('title: mf.string')).toBeLessThan(src.indexOf('slug: mf.slug'));
    expect(src).toContain(`venue: mf.ref('events.venue', { onDelete: 'cascade' }),`);
    expect(src).toContain(`kind: mf.enum(['talk', 'workshop'], { required: true }),`);
    expect(src).not.toContain('x_');
    expect(JSON.parse(out.files['package.json']).name).toBe('@modulo/mod-events');

    // Write under the repo so '@modulo/*' resolves through the workspace, import it, boot a kernel with it.
    const dir = join(import.meta.dirname, '..', `.tmp-export-${Math.random().toString(36).slice(2, 8)}`);
    tmpDirs.push(dir);
    for (const [p, content] of Object.entries(out.files as Record<string, string>)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), content);
    }
    const mod = (await import(pathToFileURL(join(dir, 'src', 'index.ts')).href)).default as ModuleDefinition;
    expect(mod.name).toBe('events');
    expect(mod.models!.map((m) => m.name)).toEqual(['events.venue', 'events.event']);
    // Round-trip: the source reproduces the published definition exactly (renamed).
    const { exportModule } = await import('../src/codegen.ts');
    expect(mod).toEqual(exportModule(unpackOrder((await ctx.repo('studio.local_module').get(created.id)).versions['1.0.0']), { rename: 'events' }).definition);

    const k = await boot(undefined, [mod]);
    const site = await k.createSite({ slug: 'ex', name: 'Ex', modules: { events: '*' } });
    const c = await k.context(site.id, null, { sudo: true });
    const v = await c.repo('events.venue').create({ name: 'Hall' });
    const e = await c.repo('events.event').create({ title: 'Launch', kind: 'talk', venue: v.id });
    expect(e.slug).toBe('launch');
    expect(e.featured).toBe(true);

    // Without --rename the export keeps the site-local name (same tables).
    const raw = await call(ctx, 'GET', `/modules/${created.id}/export`);
    expect(raw.name).toBe(created.module);
    await expect(call(ctx, 'GET', `/modules/${created.id}/export`, undefined, { rename: 'Bad Name' })).rejects.toThrow(/Invalid module name/);
  });
});
