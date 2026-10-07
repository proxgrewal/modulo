import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineModel, emptyPage, f, loadData, mf, renderTree, defaultTheme, type PageNode } from '@modulo/core';
import { createPgliteDb, defineModule, invokeRoute, Kernel, ModuloError, type SiteContext } from '@modulo/kernel';
import { appToModule, runInSandbox, SandboxError, validatePackage, type AppPackage } from '../src/index.ts';

const run = (code: string, kind = 'route', key = 'GET /', args: unknown[] = [], host = async (_op: string, _a: unknown[]) => null as unknown, limits = {}) =>
  runInSandbox({ app: 'app-test', code, kind, key, args, host, limits });

describe('engine', () => {
  beforeAll(async () => {
    await run(`app.route('GET', '/', () => 1)`); // warm the WASM module
  });

  it('runs async handlers with multiple awaited host calls', async () => {
    const calls: string[] = [];
    const host = async (op: string, args: unknown[]) => {
      calls.push(op);
      await new Promise((r) => setTimeout(r, 2));
      return { echo: args };
    };
    const out = await run(
      `app.route('GET', '/', async (req) => {
         const a = await host.fetch('https://x.io/a');
         await null;
         const [b, c] = await Promise.all([host.settings(), host.emit('e', { n: req.n })]);
         return { a, b, c, n: req.n * 2 };
       })`,
      'route',
      'GET /',
      [{ n: 21 }],
      host,
    );
    expect(out).toEqual({ a: { echo: ['https://x.io/a', {}] }, b: { echo: [] }, c: { echo: ['e', { n: 21 }] }, n: 42 });
    expect(calls.sort()).toEqual(['emit', 'fetch', 'settings']);
  });

  it('exposes no Node or host globals', async () => {
    const out = await run(
      `app.route('GET', '/', () => [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof __host, typeof globalThis.Buffer, typeof module, typeof import_meta])`,
    );
    expect(out).toEqual(Array(8).fill('undefined'));
  });

  it('terminates infinite loops (sync and async) within the CPU budget', async () => {
    const t0 = Date.now();
    await expect(run(`app.route('GET', '/', () => { while (true) {} })`, 'route', 'GET /', [], undefined, { cpuMs: 100 })).rejects.toMatchObject({
      failure: 'timeout',
      message: expect.stringMatching(/app-test.*CPU budget of 100ms/),
    });
    expect(Date.now() - t0).toBeLessThan(2000);
    await expect(run(`app.route('GET', '/', async () => { await null; for (;;) {} })`, 'route', 'GET /', [], undefined, { cpuMs: 100 })).rejects.toMatchObject({ failure: 'timeout' });
    // Top-level code is covered too.
    await expect(run(`while (1) {}`, 'route', 'GET /', [], undefined, { cpuMs: 50 })).rejects.toMatchObject({ failure: 'timeout' });
  });

  it('does not count time spent waiting on host I/O against the CPU budget, but enforces wall time', async () => {
    const slowHost = async () => {
      await new Promise((r) => setTimeout(r, 150));
      return 1;
    };
    expect(await run(`app.route('GET', '/', async () => (await host.settings()) + 1)`, 'route', 'GET /', [], slowHost, { cpuMs: 50 })).toBe(2);
    await expect(run(`app.route('GET', '/', async () => host.settings())`, 'route', 'GET /', [], slowHost, { wallMs: 50 })).rejects.toMatchObject({ failure: 'timeout' });
  });

  it('stops memory blowups and stack overflows', { timeout: 120_000 }, async () => {
    await expect(
      run(`app.route('GET', '/', () => { const a = []; for (;;) a.push('x'.repeat(1024) + a.length); })`, 'route', 'GET /', [], undefined, { memoryBytes: 8 * 1024 * 1024, cpuMs: 30000, wallMs: 60000 }),
    ).rejects.toMatchObject({ failure: 'memory', message: expect.stringMatching(/memory limit of 8MB/) });
    await expect(run(`function r(n) { return r(n + 1) + 1 } app.route('GET', '/', () => r(0))`, 'route', 'GET /', [], undefined, { cpuMs: 30000, wallMs: 60000 })).rejects.toMatchObject({ failure: 'memory' });
    // The process is fine afterwards.
    expect(await run(`app.route('GET', '/', () => 'ok')`)).toBe('ok');
  });

  it('reports deadlocks, missing handlers, syntax errors and thrown errors with the app name', async () => {
    await expect(run(`app.route('GET', '/', () => new Promise(() => {}))`)).rejects.toMatchObject({ failure: 'deadlock' });
    await expect(run(`app.route('GET', '/other', () => 1)`)).rejects.toThrow(/did not register a route handler for "GET \/"/);
    await expect(run(`app.route('GET', '/', () => {`)).rejects.toMatchObject({ failure: 'load', status: 500 });
    const err: any = await run(`app.route('GET', '/', () => { throw new TypeError('boom') })`).catch((e: SandboxError) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect(err).toBeInstanceOf(ModuloError);
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/App "app-test" route "GET \/" failed: TypeError: boom/);
  });

  it('caps host calls per invocation and isolates invocations', async () => {
    await expect(
      run(`app.route('GET', '/', async () => { for (let i = 0; i < 20; i++) await host.settings(); })`, 'route', 'GET /', [], async () => 1, { maxHostCalls: 5 }),
    ).rejects.toThrow(/Host call limit exceeded/);
    // Globals set in one invocation are gone in the next.
    await run(`globalThis.leak = 1; app.route('GET', '/', () => 1)`);
    expect(await run(`app.route('GET', '/', () => typeof leak)`)).toBe('undefined');
    // Concurrent invocations work independently.
    const outs = await Promise.all([1, 2, 3, 4, 5].map((n) => run(`app.route('GET', '/', async (x) => (await host.settings()) * x)`, 'route', 'GET /', [n], async () => 10)));
    expect(outs).toEqual([10, 20, 30, 40, 50]);
  });
});

describe('manifest validation', () => {
  const base = (m: Record<string, unknown> = {}): AppPackage =>
    ({ manifest: { name: 'app-x', version: '1.0.0', kernel: '^1.0.0', label: 'X', description: '', capabilities: [], ...m }, code: '' }) as AppPackage;

  it('accepts a valid package and rejects bad ones with clear problems', () => {
    expect(validatePackage(base()).manifest.name).toBe('app-x');
    expect(() => validatePackage(base({ name: 'shop' }))).toThrow(/app-<lowercase-name>/);
    expect(() => validatePackage(base({ capabilities: ['root:everything'] }))).toThrow(/malformed capability "root:everything"/);
    expect(() => validatePackage(base({ blocks: [{ type: 'core:hero', label: 'H', fields: {} }] }))).toThrow(/must be "app-x:<name>"/);
    expect(() => validatePackage(base({ routes: [{ method: 'GET', path: '/', surface: 'site' }] }))).toThrow(/must live under \/app-x\//);
    expect(() => validatePackage(base({ models: [{ name: 'shop.product', fields: {} }] }))).toThrow(/must be named "app_x.<name>"/);
    expect(() => validatePackage(base({ hooks: [{ hook: 'model.shop.product.beforeCreate', kind: 'filter' }] }))).toThrow(/requires capability "write:shop.product"/);
    expect(validatePackage(base({ capabilities: ['write:shop.product'], hooks: [{ hook: 'model.shop.product.beforeCreate', kind: 'filter' }] }))).toBeTruthy();
  });
});

/* ───────────────────────── kernel integration ───────────────────────── */

const shop = defineModule({
  name: 'shop',
  version: '1.0.0',
  kernel: '^1.0.0',
  models: [
    defineModel({ name: 'shop.product', titleField: 'title', fields: { title: mf.string({ required: true }), price: mf.money() }, access: { read: 'public' } }),
    defineModel({ name: 'shop.customer', fields: { email: mf.email() } }),
  ],
  hooks: [],
});

const APP_CODE = `
app.route('GET', '/products', async () => ({ body: await host.repo('shop.product').find({ order: 'title asc' }) }));
app.route('POST', '/products', async (req) => ({ status: 201, body: await host.repo('shop.product').create(req.body) }));
app.route('GET', '/customers', async () => host.repo('shop.customer').find());
app.route('POST', '/notes', async (req) => host.repo('app_demo.note').create({ text: req.body.text }));
app.route('GET', '/notes', async () => host.repo('app_demo.note').find());
app.route('POST', '/ping', async (req) => { await host.emit(req.body.event, { text: req.body.text }); return { ok: true }; });
app.route('GET', '/settings', async () => host.settings());
app.route('GET', '/boom', () => { throw new Error('kaboom'); });
app.route('GET', '/caught', async () => { try { await host.repo('shop.customer').find(); } catch (e) { return { caught: e.message }; } });
app.route('GET', '/ext', async (req) => ({ body: await host.fetch(req.query.url, { method: 'POST', body: { a: 1 }, headers: { 'x-k': 'v' } }) }));
app.route('GET', '/app-demo/html', () => '<script>alert(1)</script>');
app.on('app-demo.ping', async (p) => { await host.repo('app_demo.note').create({ text: 'event:' + p.text }); });
app.on('shop.product.created', async (p) => { const prod = await host.repo('shop.product').get(p.id); await host.repo('app_demo.note').create({ text: 'new product ' + prod.title }); });
app.hook('page.title', (title, info) => title + ' | ' + info.site);
app.hook('model.shop.product.beforeCreate', (values) => ({ ...values, title: values.title.toUpperCase() }));
app.block('app-demo:badge', (props) => ({
  tag: 'div', attrs: { class: 'badge', onclick: 'steal()', 'data-x': 1 },
  children: [
    { tag: 'strong', children: [props.label] },
    { tag: 'script', children: ['alert(1)'] },
    { tag: 'a', attrs: { href: 'javascript:alert(1)', title: 'bad' }, children: ['link'] },
    { tag: 'img', attrs: { src: 'https://img.example/a.png', alt: '<x>' } },
    '<b>escaped</b>',
  ],
}));
`;

const demoPkg = (caps: string[] = ['read:shop.product', 'write:shop.product', 'http:api.example.com', 'http:*.cdn.example.com', 'emit:app-demo.*'], modelHook = true): AppPackage => ({
  manifest: {
    name: 'app-demo',
    version: '1.0.0',
    kernel: '^1.0.0',
    label: 'Demo',
    description: 'Demo app',
    depends: { shop: '^1.0.0' },
    capabilities: caps,
    hooks: [
      { hook: 'page.title', kind: 'filter' },
      ...(modelHook ? [{ hook: 'model.shop.product.beforeCreate', kind: 'filter' as const }] : []),
    ],
    routes: [
      { method: 'GET', path: '/products', surface: 'api', permission: 'public' },
      { method: 'POST', path: '/products', surface: 'api' },
      { method: 'GET', path: '/customers', surface: 'api' },
      { method: 'POST', path: '/notes', surface: 'api' },
      { method: 'GET', path: '/notes', surface: 'api' },
      { method: 'POST', path: '/ping', surface: 'api' },
      { method: 'GET', path: '/settings', surface: 'api' },
      { method: 'GET', path: '/boom', surface: 'api' },
      { method: 'GET', path: '/caught', surface: 'api' },
      { method: 'GET', path: '/ext', surface: 'api' },
      { method: 'GET', path: '/app-demo/html', surface: 'site' },
    ],
    events: [{ event: 'app-demo.ping' }, { event: 'shop.product.created' }],
    blocks: [{ type: 'app-demo:badge', label: 'Badge', fields: { label: f.text({ default: 'Hi' }) } }],
    settings: { greeting: f.text({ default: 'hello' }) },
    models: [defineModel({ name: 'app_demo.note', fields: { text: mf.text() } })],
  },
  code: APP_CODE,
});

describe('appToModule on a real kernel', () => {
  let kernel: Kernel;
  let ctx: SiteContext;
  const logs: string[] = [];

  async function boot(caps?: string[]) {
    const app = appToModule(demoPkg(caps, !caps), { log: (_a, m) => void logs.push(m) });
    kernel = await Kernel.create({ db: await createPgliteDb(), modules: [shop, app] });
    const site = await kernel.createSite({ slug: 's', name: 'Site', modules: { 'app-demo': '*' } });
    ctx = await kernel.context(site.id, null, { sudo: true });
  }
  afterEach(async () => {
    vi.unstubAllGlobals();
    await kernel?.close();
  });
  const call = (method: string, path: string, body?: unknown, query?: Record<string, string>) => invokeRoute(ctx, { module: 'app-demo', method, path, body, query });

  it('gates repositories by capability and allows the app own models', async () => {
    await boot(['read:shop.product']);
    await ctx.repo('shop.product').create({ title: 'b', price: 2 });
    await ctx.repo('shop.product').create({ title: 'a', price: 1 });
    const res = await call('GET', '/products');
    expect((res.body as any[]).map((p) => p.title)).toEqual(['a', 'b']);
    // write without write:shop.product
    const denied = await call('POST', '/products', { title: 'c' }).catch((e) => e);
    expect(denied).toBeInstanceOf(ModuloError);
    expect(denied.status).toBe(403);
    expect(denied.code).toBe('capability_denied');
    expect(denied.message).toMatch(/Capability denied: app-demo lacks "write:shop.product" \(host\.repo\('shop\.product'\)\.create\)/);
    // read of an ungranted model
    await expect(call('GET', '/customers')).rejects.toThrow(/lacks "read:shop.customer"/);
    // the app can catch denials itself
    expect((await call('GET', '/caught')).body).toEqual({ caught: expect.stringMatching(/Capability denied.*read:shop\.customer/) });
    // own model is implicitly allowed
    const note = (await call('POST', '/notes', { text: 'hi' })).body as any;
    expect(note.text).toBe('hi');
    expect(((await call('GET', '/notes')).body as any[]).map((n) => n.text)).toEqual(['hi']);
  });

  it('applies hooks: plain filters and model filters (capability-gated at definition time)', async () => {
    await boot();
    expect(await ctx.hooks.filter('page.title', 'Home', { site: 'Acme' })).toBe('Home | Acme');
    const created = (await call('POST', '/products', { title: 'shouty', price: 3 })).body as any;
    expect(created).toMatchObject({ title: 'SHOUTY', price: 3 });
    // Without write:shop.product the model hook is refused when the package is converted.
    expect(() => appToModule(demoPkg(['read:shop.product']))).toThrow(/requires capability "write:shop.product"/);
  });

  it('delivers events via kernel.drain() and gates host.emit by emit: patterns', async () => {
    await boot();
    expect((await call('POST', '/ping', { event: 'app-demo.ping', text: 'yo' })).body).toEqual({ ok: true });
    await expect(call('POST', '/ping', { event: 'shop.order.created', text: 'spoof' })).rejects.toThrow(/lacks "emit:shop.order.created"/);
    await ctx.repo('shop.product').create({ title: 'widget' });
    await kernel.drain();
    const texts = ((await call('GET', '/notes')).body as any[]).map((n) => n.text).sort();
    expect(texts).toEqual(['event:yo', 'new product WIDGET']);
  });

  it('enforces the fetch allowlist (mocked global fetch)', async () => {
    await boot();
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('pong', { status: 200, headers: { 'x-r': '1', 'set-cookie': 'a=b' } }));
    vi.stubGlobal('fetch', fetchMock);
    const ok = await call('GET', '/ext', undefined, { url: 'https://api.example.com/v1?q=1' });
    expect(ok.body).toEqual({ status: 200, headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-r': '1' }, text: 'pong' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1?q=1');
    expect(init).toMatchObject({ method: 'POST', body: '{"a":1}', redirect: 'manual', headers: { 'x-k': 'v' } });
    // wildcard subdomain capability
    await call('GET', '/ext', undefined, { url: 'https://img.cdn.example.com/x' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const bad of ['https://evil.com/', 'https://api.example.com.evil.com/', 'https://api.example.com:8443/', 'https://cdn.example.com/', 'file:///etc/passwd']) {
      await expect(call('GET', '/ext', undefined, { url: bad })).rejects.toThrow(/Capability denied/);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns settings, sanitises string responses, and turns app errors into 500s without crashing', async () => {
    await boot();
    expect((await call('GET', '/settings')).body).toEqual({ greeting: 'hello' });
    const html = await invokeRoute(ctx, { surface: 'site', method: 'GET', path: '/app-demo/html' });
    expect(html.headers).toMatchObject({ 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': expect.stringContaining('sandbox') });
    const err = await call('GET', '/boom').catch((e) => e);
    expect(err).toBeInstanceOf(ModuloError);
    expect(err).toMatchObject({ status: 500, code: 'app_error' });
    expect(err.message).toMatch(/app-demo.*kaboom/);
    expect((await call('GET', '/settings')).body).toEqual({ greeting: 'hello' }); // still serving
    // Route permissions still apply (api default "auth").
    const anon = await kernel.context(ctx.site.id, null);
    await expect(invokeRoute(anon, { module: 'app-demo', method: 'GET', path: '/notes' })).rejects.toThrow(/Authentication required/);
    expect((await invokeRoute(anon, { module: 'app-demo', method: 'GET', path: '/products' })).status).toBe(200);
  });

  it('pre-renders blocks in load() and sanitises the VNode output', async () => {
    await boot();
    const tree: PageNode = emptyPage();
    tree.slots!.default!.push({ id: 'b1', type: 'app-demo:badge', props: { label: 'Fresh <bread>' } });
    expect(ctx.runtime.blocks.validateTree(tree)).toEqual([]);
    const data = await loadData(tree, ctx.runtime.blocks, { siteId: ctx.site.id, scope: { path: '/' }, services: { ctx } });
    const { html } = renderTree(tree, { registry: ctx.runtime.blocks, theme: defaultTheme, data });
    expect(html).toContain('<strong>Fresh &lt;bread&gt;</strong>');
    expect(html).toContain('class="badge"');
    expect(html).toContain('data-x="1"');
    expect(html).toContain('&lt;b&gt;escaped&lt;/b&gt;');
    expect(html).toContain('<img src="https://img.example/a.png" alt="&lt;x&gt;">');
    expect(html).not.toMatch(/script|onclick|javascript:/i);
    expect(html).toContain('<a title="bad">link</a>');
  });
});
