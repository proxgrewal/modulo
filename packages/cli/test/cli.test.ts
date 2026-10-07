import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineModel, mf } from '@modulo/core';
import { defineModule, invokeRoute, Kernel, type ModuleDefinition } from '@modulo/kernel';
import { bootKernel } from '../../server/src/boot.ts';
import studio from '../../../modules/studio/src/index.ts';
import { check, compatibilityMatrix, main, memoryIO, moduleChange, moduleExport, moduleList, moduleNew, siteCreate, siteList, userCreate, migrate } from '../src/index.ts';

const base = defineModule({
  name: 'base',
  version: '1.0.0',
  kernel: '^1.0.0',
  required: true,
  models: [defineModel({ name: 'base.partner', fields: { name: mf.string({ required: true }) } })],
});
const blog = (version = '1.0.0') =>
  defineModule({ name: 'blog', version, kernel: '^1.0.0', depends: { base: '^1.0.0' }, models: [defineModel({ name: 'blog.post', fields: { title: mf.string() } })] });
const comments = defineModule({ name: 'comments', version: '1.0.0', kernel: '^1.0.0', depends: { blog: '^1.0.0' } });

let kernel: Kernel | null = null;
const cleanup: string[] = [];
afterEach(async () => {
  await kernel?.close();
  kernel = null;
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(modules: ModuleDefinition[] = [base, blog(), blog('1.1.0'), comments, studio]) {
  kernel = await bootKernel({ databaseUrl: 'memory', modules });
  return kernel;
}
/** Share one kernel across main() calls (main closes the kernel it is given). */
const keep = (k: Kernel) => async () => Object.assign(Object.create(k), { close: async () => {} }) as Kernel;
const args = (o: Record<string, string | boolean>, ...pos: string[]) => ({ ...o, _: pos });

describe('users and sites', () => {
  it('creates users and sites and lists them', async () => {
    const k = await boot();
    const io = memoryIO();
    await userCreate(k, args({ email: 'Owner@Example.com', password: 'password1', name: 'Owner' }), io);
    expect(io.text()).toMatch(/Created user owner@example.com/);
    await siteCreate(k, args({ slug: 'acme', name: 'Acme', owner: 'owner@example.com', modules: 'blog' }), io);
    expect(io.text()).toMatch(/Created site acme .* owned by owner@example.com/);
    expect(io.text()).toMatch(/Modules: .*base@1.0.0.*blog@1.1.0/);
    const site = await k.getSite('acme');
    const ctx = await k.context(site.id, (await k.db.query(`SELECT id FROM modulo_users`)).rows[0].id);
    expect(ctx.user?.role).toBe('owner');

    const io2 = memoryIO();
    await siteList(k, args({}), io2);
    expect(io2.stdout[0]).toMatch(/^slug\s+name/);
    expect(io2.text()).toMatch(/acme\s+Acme\s+base,blog/);

    // Errors are printed nicely with exit code 1.
    const io3 = memoryIO();
    expect(await main(['user', 'create', '--email', 'owner@example.com', '--password', 'password1'], { io: io3, boot: keep(k) })).toBe(1);
    expect(io3.stderr.join('\n')).toMatch(/error: Email already registered/);
    const io4 = memoryIO();
    expect(await main(['site', 'create', '--slug', 'x'], { io: io4, boot: keep(k) })).toBe(2);
    expect(io4.stderr.join('\n')).toMatch(/--name is required/);
  });
});

describe('module commands', () => {
  it('prints install/upgrade/uninstall plans and applies them', async () => {
    const k = await boot();
    await k.createSite({ slug: 's', name: 'S' });
    let io = memoryIO();
    await moduleChange(k, args({ site: 's', version: '1.0.0', 'dry-run': true }, 'install', 'comments'), io);
    expect(io.stdout).toContain('  + blog 1.1.0');
    expect(io.stdout).toContain('  + comments 1.0.0');
    expect(io.text()).toMatch(/Dry run/);
    expect((await k.installedModules((await k.getSite('s')).id)).map((m) => m.name)).toEqual(['base']);

    io = memoryIO();
    expect(await main(['module', 'install', 'blog', '--site', 's', '--version', '1.0.0'], { io, boot: keep(k) })).toBe(0);
    expect(io.text()).toMatch(/\+ blog 1\.0\.0/);
    expect(io.text()).toMatch(/Created tables \(1\): m_blog__post/);
    expect(io.text()).toMatch(/Applied/);

    io = memoryIO();
    await moduleList(k, args({ site: 's' }), io);
    expect(io.text()).toMatch(/blog\s+1\.0\.0\s+1\.1\.0\s+update → 1\.1\.0/);
    expect(io.text()).toMatch(/comments\s+1\.0\.0\s+available/);

    io = memoryIO();
    await moduleChange(k, args({ site: 's' }, 'upgrade', 'blog'), io);
    expect(io.stdout).toContain('  ^ blog 1.0.0 -> 1.1.0');

    await moduleChange(k, args({ site: 's' }, 'install', 'comments'), memoryIO());
    io = memoryIO();
    expect(await main(['module', 'uninstall', 'blog', '--site', 's'], { io, boot: keep(k) })).toBe(1);
    expect(io.stderr.join('\n')).toMatch(/error: Cannot uninstall blog: required by comments/);
    io = memoryIO();
    expect(await main(['module', 'uninstall', 'blog', '--site', 's', '--cascade'], { io, boot: keep(k) })).toBe(0);
    expect(io.stdout).toContain('  - blog 1.1.0');
    expect(io.stdout).toContain('  - comments 1.0.0');

    io = memoryIO();
    expect(await main(['module', 'install', 'nope', '--site', 's'], { io, boot: keep(k) })).toBe(1);
    expect(io.stderr.join('\n')).toMatch(/nope: not found in catalog/);

    io = memoryIO();
    await moduleList(k, args({}), io);
    expect(io.text()).toMatch(/blog\s+1\.1\.0, 1\.0\.0\s+\^1\.0\.0\s+base \^1\.0\.0/);

    io = memoryIO();
    await migrate(k, args({}), io);
    expect(io.text()).toMatch(/Schema up to date/);
  });

  it('exports a studio module to a directory', async () => {
    const k = await boot();
    const site = await k.createSite({ slug: 'st', name: 'St', modules: { studio: '*' } });
    const ctx = await k.context(site.id, null, { sudo: true });
    const rec = (
      await invokeRoute(ctx, {
        module: 'studio',
        method: 'POST',
        path: '/modules',
        body: { name: 'events', label: 'Events', definition: { models: [{ name: 'events.event', fields: { title: { kind: 'string', required: true } } }] } },
      })
    ).body as any;
    await invokeRoute(ctx, { module: 'studio', method: 'POST', path: `/modules/${rec.id}/publish` });
    const out = join(import.meta.dirname, '..', `.tmp-export-${Math.random().toString(36).slice(2, 8)}`);
    cleanup.push(out);
    const io = memoryIO();
    await moduleExport(k, args({ site: 'st', module: 'events', out, rename: 'events' }), io);
    expect(io.text()).toMatch(/Exported events as module "events" v1.0.0/);
    expect(readFileSync(join(out, 'src', 'index.ts'), 'utf8')).toContain(`name: 'events.event'`);
    expect(existsSync(join(out, 'test', 'module.test.ts'))).toBe(true);
    await expect(moduleExport(k, args({ site: 'st', module: 'events', out }), memoryIO())).rejects.toThrow(/not empty/);
  });
});

describe('module new', () => {
  it('scaffolds a working module and refuses to overwrite', async () => {
    const dir = join(import.meta.dirname, '..', `.tmp-new-${Math.random().toString(36).slice(2, 8)}`);
    cleanup.push(dir);
    const io = memoryIO();
    await moduleNew(null, args({ dir }, 'my-widgets'), io);
    for (const f of ['package.json', 'src/index.ts', 'test/my-widgets.test.ts', 'README.md']) expect(existsSync(join(dir, 'my-widgets', f))).toBe(true);
    await expect(moduleNew(null, args({ dir }, 'my-widgets'), memoryIO())).rejects.toThrow(/already exists/);
    await expect(moduleNew(null, args({ dir }, 'Bad_Name'), memoryIO())).rejects.toThrow(/invalid module name/);

    const mod = (await import(pathToFileURL(join(dir, 'my-widgets', 'src', 'index.ts')).href)).default as ModuleDefinition;
    expect(mod.name).toBe('my-widgets');
    const k = await boot([mod]);
    const site = await k.createSite({ slug: 'w', name: 'W', modules: { 'my-widgets': '*' } });
    const ctx = await k.context(site.id, null, { sudo: true });
    await ctx.repo('my_widgets.item').create({ title: 'Hello' });
    const res = await invokeRoute(ctx, { module: 'my-widgets', method: 'GET', path: '/items' });
    expect((res.body as any[]).map((r) => r.title)).toEqual(['Hello']);
    expect(ctx.runtime.blocks.get('my-widgets:items')).toBeTruthy();
  });
});

describe('check (compatibility matrix)', () => {
  const entries = (defs: ModuleDefinition[]) => defs.map((def) => ({ def }));

  it('passes for compatible modules and fails on kernel / dependency problems', async () => {
    const good = compatibilityMatrix({ entries: entries([base, blog(), comments]) });
    expect(good.kernel).toBe('1.0.0');
    expect(good.rows.every((r) => r.current && r.nextMinor && !r.nextMajor && r.depsOk)).toBe(true);

    const legacy = defineModule({ name: 'legacy', version: '0.3.0', kernel: '^0.9.0' });
    const orphan = defineModule({ name: 'orphan', version: '1.0.0', kernel: '^1.0.0', depends: { missing: '^1.0.0', blog: '^2.0.0' } });
    const future = defineModule({ name: 'future', version: '1.0.0', kernel: '>=1.0.0 <3.0.0' });
    const io = memoryIO();
    const code = await check(null, args({}), io, { entries: entries([base, blog(), legacy, orphan, future]) });
    expect(code).toBe(1);
    const text = io.text();
    expect(io.stdout[0]).toMatch(/module\s+version\s+kernel 1\.0\.0\s+1\.1\.0 \(minor\)\s+2\.0\.0 \(major\)\s+deps/);
    expect(text).toMatch(/legacy\s+0\.3\.0\s+FAIL\s+FAIL\s+no\s+ok/);
    expect(text).toMatch(/orphan\s+1\.0\.0\s+ok\s+ok\s+no\s+missing: missing; blog \^2\.0\.0: unsatisfied/);
    expect(text).toMatch(/future\s+1\.0\.0\s+ok\s+ok\s+ok\s+ok/);
    expect(io.stderr.join('\n')).toMatch(/incompatible with kernel 1\.0\.0: legacy@0\.3\.0, orphan@1\.0\.0/);

    const io2 = memoryIO();
    const ran: string[] = [];
    const ok = await check(null, args({ 'run-tests': true }), io2, {
      entries: entries([base, blog()]),
      runTests: (e) => (ran.push(e.def.name), e.def.name !== 'blog'),
    });
    expect(ran).toEqual(['base', 'blog']);
    expect(ok).toBe(1);
    expect(io2.text()).toMatch(/blog\s+1\.0\.0\s+ok\s+ok\s+no\s+ok\s+FAIL/);
  });
});

describe('main', () => {
  it('prints help and rejects unknown commands/options', async () => {
    let io = memoryIO();
    expect(await main(['--help'], { io })).toBe(0);
    expect(io.text()).toMatch(/module install <name>/);
    expect(io.text()).toMatch(/check\s+Compatibility matrix/);
    io = memoryIO();
    expect(await main(['module', 'install', '--help'], { io })).toBe(0);
    expect(io.text()).toMatch(/--cascade|--site/);
    io = memoryIO();
    expect(await main(['frobnicate'], { io })).toBe(2);
    expect(io.stderr[0]).toMatch(/unknown command "frobnicate"/);
    io = memoryIO();
    expect(await main(['site', 'list', '--bogus'], { io })).toBe(2);
    expect(io.stderr[0]).toMatch(/bogus/);
  });
});
