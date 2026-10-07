import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kernel } from '@modulo/kernel';
import { bootKernel, createApp, LocalStorage } from '../src/index.ts';
import { generatePublisherKeys, signPackage } from '../../../modules/marketplace/src/index.ts';

/**
 * Every discovered module booted together through the real HTTP app:
 * cross-module patches, glue activation, shop checkout, blog, forms, SEO, Studio.
 */
let kernel: Kernel;
let app: ReturnType<typeof createApp>['app'];
let dir: string;
let cookie = '';

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...(cookie ? { cookie } : {}), ...extra };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get('set-cookie');
  if (sc?.startsWith('modulo_session=')) cookie = sc.split(';')[0]!;
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data, headers: res.headers };
}

beforeAll(async () => {
  delete process.env.ANTHROPIC_API_KEY; // never call the real API from tests: exercise the fallback
  dir = mkdtempSync(join(tmpdir(), 'modulo-full-'));
  kernel = await bootKernel({ databaseUrl: 'memory' });
  ({ app } = createApp({ kernel, storage: new LocalStorage(dir), openSignup: true }));
  await call('POST', '/api/auth/signup', { email: 'admin@demo.io', password: 'demo-pass-123' });
});
afterAll(async () => {
  await kernel.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('full stack', () => {
  it('passes the compatibility check: every catalog module resolves against this kernel', () => {
    expect(kernel.catalog.names().length).toBeGreaterThanOrEqual(10);
  });

  it('creates a site with shop + blog + forms + seo; glue auto-activates; patches compose the header', async () => {
    const r = await call('POST', '/api/sites', { slug: 'demo', name: 'Demo Co', modules: ['shop', 'blog', 'forms', 'seo', 'studio'] });
    expect(r.status).toBe(201);
    const mods = (await call('GET', '/api/sites/demo/modules')).data.installed;
    const names = mods.map((m: any) => m.name);
    expect(names).toEqual(expect.arrayContaining(['core', 'pages', 'media', 'shop', 'payments', 'blog', 'forms', 'seo', 'shop-blog']));
    expect(mods.find((m: any) => m.name === 'shop-blog').auto).toBe(true);
    expect(mods.find((m: any) => m.name === 'payments').requested).toBe(false);
    const layout = (await call('GET', '/api/sites/demo/layout')).data;
    expect(layout.conflicts).toEqual([]);
    expect(layout.failures).toEqual([]);
    cookie = cookie; // keep session
    const home = (await app.request('/s/demo')).text();
    const html = await home;
    expect(html).toContain('href="/s/demo/shop">Shop</a>');
    expect(html).toContain('href="/s/demo/blog">Blog</a>');
    expect(html).toMatch(/<link rel="canonical" href="[^"]*\/s\/demo"/);
  });

  it('shop: products, cart, checkout with the fake provider, order paid via events', async () => {
    const prod = await call('POST', '/api/sites/demo/data/shop.product', { title: 'Sourdough Loaf', price: 8.5, stock: 3, description: '<p>Crusty</p>' });
    expect(prod.status).toBe(201);
    const grid = await (await app.request('/s/demo/shop')).text();
    expect(grid).toContain('Sourdough Loaf');
    const detail = await app.request(`/s/demo/shop/${prod.data.slug}`);
    expect(detail.status).toBe(200);
    const anon = async (m: string, p: string, b?: unknown) => {
      const res = await app.request(p, { method: m, headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
      return { status: res.status, data: await res.json().catch(() => null) };
    };
    const cart = await anon('POST', '/s/demo/_api/m/shop/cart/items', { product: prod.data.id, qty: 2 });
    expect(cart.status).toBeLessThan(300);
    const token = cart.data.token ?? cart.data.cart?.token;
    expect(token).toBeTruthy();
    const co = await anon('POST', '/s/demo/_api/m/shop/checkout', { token, email: 'buyer@x.io', base: '/s/demo' });
    expect(co.status).toBeLessThan(300);
    expect(co.data.redirect).toContain('/payments/fake/');
    const ref = co.data.redirect.split('/payments/fake/')[1].split(/[?/]/)[0];
    const pay = await app.request(`/s/demo/payments/fake/${ref}`);
    expect(await pay.text()).toMatch(/Pay/i);
    const confirm = await anon('POST', `/s/demo/_api/m/payments/fake/${ref}/confirm`, {});
    expect(confirm.status).toBeLessThan(300);
    await kernel.drain();
    const orders = (await call('GET', '/api/sites/demo/m/shop/orders')).data;
    const list = Array.isArray(orders) ? orders : orders.items;
    expect(list[0]).toMatchObject({ status: 'paid', email: 'buyer@x.io' });
    const after = (await call('GET', `/api/sites/demo/data/shop.product/${prod.data.id}`)).data;
    expect(after.stock).toBe(1);
    expect((await anon('GET', '/api/sites/demo/m/shop/orders')).status).toBe(401);
  });

  it('blog + seo: published posts render, drafts are hidden, sitemap and RSS include posts', async () => {
    await call('POST', '/api/sites/demo/data/blog.post', { title: 'Launch day', body: '<p>We are live!</p><script>x</script>', status: 'published' });
    await call('POST', '/api/sites/demo/data/blog.post', { title: 'Secret draft', body: '<p>shh</p>' });
    await kernel.drain();
    const list = await (await app.request('/s/demo/blog')).text();
    expect(list).toContain('Launch day');
    expect(list).not.toContain('Secret draft');
    const post = await (await app.request('/s/demo/blog/launch-day')).text();
    expect(post).toContain('We are live!');
    expect(post).not.toContain('<script>x');
    expect((await app.request('/s/demo/blog/secret-draft')).status).toBe(404);
    const sitemap = await (await app.request('/s/demo/sitemap.xml')).text();
    expect(sitemap).toContain('/s/demo/blog/launch-day');
    const rss = await app.request('/s/demo/blog/rss.xml');
    expect(rss.headers.get('content-type')).toContain('rss');
  });

  it('forms: the shipped contact form accepts submissions and the notify job runs', async () => {
    const forms = (await call('GET', '/api/sites/demo/data/forms.form')).data.items;
    const form = forms[0];
    expect(form).toBeTruthy();
    const values: Record<string, string> = {};
    for (const f of form.fields) values[f.name] = f.type === 'email' ? 'a@b.io' : f.type === 'select' ? f.options[0] : 'hello';
    const res = await app.request(`/s/demo/_api/m/forms/forms/${form.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) });
    expect(res.status).toBeLessThan(300);
    await kernel.drain();
    const subs = (await call('GET', `/api/sites/demo/m/forms/forms/${form.id}/submissions`)).data;
    expect(subs.submissions).toHaveLength(1);
    expect(subs.total).toBe(1);
  });

  it('studio: a no-code model becomes a real table, appears in the headless API and exports as a module', async () => {
    const created = await call('POST', '/api/sites/demo/m/studio/modules', {
      name: 'events',
      label: 'Events',
      definition: { models: [{ name: 'events.event', label: 'Event', fields: { title: { kind: 'string', required: true }, starts_at: { kind: 'datetime' }, seats: { kind: 'int' } } }] },
    });
    expect(created.status).toBeLessThan(300);
    const id = created.data.id;
    const pub = await call('POST', `/api/sites/demo/m/studio/modules/${id}/publish`, {});
    expect(pub.status).toBeLessThan(300);
    const models = (await call('GET', '/api/sites/demo/models')).data.map((m: any) => m.name);
    const eventModel = models.find((n: string) => n.endsWith('.event') && n.startsWith('x_'));
    expect(eventModel).toBeTruthy();
    const ev = await call('POST', `/api/sites/demo/data/${eventModel}`, { title: 'Bake-off', seats: 40 });
    expect(ev.status).toBe(201);
    const gql = await call('POST', '/api/sites/demo/graphql', { query: `{ ${eventModel.replace('.', '_')}_list { title seats } }` });
    expect(gql.data.data[`${eventModel.replace('.', '_')}_list`]).toEqual([{ title: 'Bake-off', seats: 40 }]);
    const exp = await call('GET', `/api/sites/demo/m/studio/modules/${id}/export?rename=events`);
    const files = exp.data.files ?? exp.data;
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['package.json', 'src/index.ts']));
    expect(files['src/index.ts']).toContain('defineModule');
  });

  it('ai: generates a valid layout from a prompt (deterministic fallback without an API key)', async () => {
    await call('POST', '/api/sites/demo/modules/apply', { install: { ai: '*' } });
    const r = await call('POST', '/api/sites/demo/m/ai/generate', { prompt: 'A bakery landing page with pricing, testimonials and FAQ', mode: 'page' });
    expect(r.status).toBe(200);
    expect(r.data.source).toBe('fallback');
    expect(r.data.tree.type).toBe('core:page');
    const types = JSON.stringify(r.data.tree);
    expect(types).toContain('core:hero');
    expect(types).toContain('core:pricing');
    const page = await call('POST', '/api/sites/demo/m/pages/pages', { title: 'Bakery', path: '/bakery', tree: r.data.tree });
    expect(page.status).toBe(201);
  });

  it('marketplace: a signed community app is uploaded, consented, installed and runs sandboxed', async () => {
    await call('POST', '/api/sites/demo/modules/apply', { install: { marketplace: '*' } });
    const keys = generatePublisherKeys();
    const pkg = signPackage(
      {
        manifest: {
          name: 'app-greeter',
          version: '1.0.0',
          kernel: '^1.0.0',
          label: 'Greeter',
          description: 'Greets visitors',
          capabilities: ['read:shop.product'],
          routes: [{ method: 'GET', path: '/hello', surface: 'api', permission: 'public' }],
        },
        code: `app.route('GET', '/hello', async () => ({ body: { products: (await host.repo('shop.product').find()).length } }));`,
      },
      keys.privateKey,
    );
    expect((await call('POST', '/api/sites/demo/m/marketplace/packages', pkg)).status).toBeLessThan(300);
    const noConsent = await call('POST', '/api/sites/demo/m/marketplace/packages/app-greeter/install', {});
    expect(noConsent.status).toBe(400);
    const ok = await call('POST', '/api/sites/demo/m/marketplace/packages/app-greeter/install', { acceptCapabilities: ['read:shop.product'] });
    expect(ok.status).toBeLessThan(300);
    const hello = await app.request('/api/sites/demo/m/app-greeter/hello');
    expect(await hello.json()).toEqual({ products: 1 });
  });

  it('uninstalling blog removes the glue module automatically and the nav link disappears', async () => {
    const plan = await call('POST', '/api/sites/demo/modules/plan', { uninstall: ['blog'] });
    expect(plan.status).toBe(200);
    expect(plan.data.removed.map((m: any) => m.name).sort()).toEqual(['blog', 'shop-blog']);
    await call('POST', '/api/sites/demo/modules/apply', { uninstall: ['blog'] });
    const html = await (await app.request('/s/demo')).text();
    expect(html).not.toContain('>Blog</a>');
    expect(html).toContain('>Shop</a>');
  });
});
