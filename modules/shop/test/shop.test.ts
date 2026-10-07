import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadData, renderDocument, type PageNode } from '@modulo/core';
import { createPgliteDb, defineModule, ForbiddenError, invokeRoute, Kernel, UnauthorizedError, ValidationError, type SiteContext, type SiteInfo } from '@modulo/kernel';
import payments from '../../payments/src/index.ts';
import shop, { ADD_TO_CART, CART_BUTTON, CART_ISLAND, sanitizeRichText, type Mail, type PriceInput, type ShopService } from '../src/index.ts';

const mails: Mail[] = [];
const events: { event: string; payload: any }[] = [];

/** Third-party module: captures mail, listens to shop events, adds a bulk discount via `shop.price`. */
const extras = defineModule({
  name: 'extras',
  version: '1.0.0',
  kernel: '^1.0.0',
  depends: { shop: '^1.0.0' },
  settings: {},
  hooks: [
    { hook: 'shop.mailer', kind: 'filter', fn: () => ({ send: (m: Mail) => void mails.push(m) }) },
    {
      hook: 'shop.price',
      kind: 'filter',
      id: 'bulk',
      after: ['shop'],
      // 1.00 off each unit when buying 5 or more of a product.
      fn: (v: PriceInput) => (v.qty >= 5 ? { ...v, unit: v.unit - 1 } : v),
    },
  ],
  events: ['shop.order.paid', 'shop.order.placed', 'shop.order.cancelled'].map((event) => ({ event, handler: (payload: any) => void events.push({ event, payload }) })),
});

let kernel: Kernel;
let site: SiteInfo;
let admin: SiteContext;
let anon: SiteContext;

beforeEach(async () => {
  mails.length = 0;
  events.length = 0;
  kernel = await Kernel.create({ db: await createPgliteDb(), modules: [payments, shop, extras] });
  site = await kernel.createSite({ slug: 't', name: 'Test Shop', modules: { shop: '*', extras: '*' } });
  admin = await kernel.context(site.id, null, { sudo: true });
  anon = await kernel.context(site.id, null);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await kernel?.close();
});

const S = (ctx: SiteContext) => ctx.service<ShopService>('shop');
const product = (values: Record<string, unknown>) => admin.repo('shop.product').create(values);
const api = (ctx: SiteContext, method: string, path: string, opts: { body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {}) =>
  invokeRoute(ctx, { module: 'shop', method, path, ...opts }).then((r) => r.body as any);

describe('catalog', () => {
  it('installs payments as a dependency and ships the General category', async () => {
    expect((await kernel.installedModules(site.id)).map((m) => m.name)).toEqual(expect.arrayContaining(['payments', 'shop']));
    const cats = await anon.repo('shop.category').find();
    expect(cats.map((c) => c.name)).toEqual(['General']);
    expect(cats[0]!.slug).toBe('general');
  });

  it('hides inactive products from visitors but not from managers', async () => {
    await product({ title: 'Visible', price: 5 });
    await product({ title: 'Hidden', price: 5, active: false });
    expect((await anon.repo('shop.product').find()).map((p) => p.title)).toEqual(['Visible']);
    expect(await admin.repo('shop.product').count()).toBe(2);
    expect((await S(anon).listProducts()).map((p) => p.title)).toEqual(['Visible']);
  });
});

describe('cart', () => {
  it('adds, updates and removes items with correct totals', async () => {
    const mug = await product({ title: 'Mug', price: 12.5 });
    const tee = await product({ title: 'Tee', price: '20.00' });
    let cart = await api(anon, 'POST', '/cart/items', { body: { product: mug.id } });
    expect(cart.token).toMatch(/^[\w-]{30,}$/);
    const token = cart.token;
    cart = await api(anon, 'POST', '/cart/items', { body: { token, product: mug.id, qty: 2 } });
    cart = await api(anon, 'POST', '/cart/items', { body: { token, product: tee.id, qty: 1 } });
    expect(cart.items.map((i: any) => [i.title, i.qty, i.line])).toEqual([
      ['Mug', 3, 37.5],
      ['Tee', 1, 20],
    ]);
    expect(cart).toMatchObject({ count: 4, subtotal: 57.5, discount: 0, total: 57.5, currency: 'USD' });

    cart = await api(anon, 'PATCH', `/cart/items/${mug.id}`, { body: { token, qty: 1 } });
    expect(cart).toMatchObject({ count: 2, total: 32.5 });
    cart = await api(anon, 'DELETE', `/cart/items/${tee.id}`, { query: { token } });
    expect(cart).toMatchObject({ count: 1, total: 12.5 });
    cart = await api(anon, 'PATCH', `/cart/items/${mug.id}`, { body: { token, qty: 0 } });
    expect(cart).toMatchObject({ count: 0, total: 0, items: [] });

    expect(await api(anon, 'GET', '/cart', { query: { token } })).toMatchObject({ token, count: 0 });
    expect(await api(anon, 'GET', '/cart', { query: {} })).toMatchObject({ token: null, count: 0 });
    await expect(api(anon, 'POST', '/cart/items', { body: { token, product: 'nope' } })).rejects.toThrow(ValidationError);
    await expect(api(anon, 'POST', '/cart/items', { body: { token, product: mug.id, qty: 1.5 } })).rejects.toThrow(/whole number/);
    await expect(api(anon, 'PATCH', `/cart/items/${mug.id}`, { body: { token: 'x'.repeat(32), qty: 1 } })).rejects.toThrow(/Cart not found/);
  });

  it('drops products that become unavailable', async () => {
    const a = await product({ title: 'A', price: 1 });
    const b = await product({ title: 'B', price: 2 });
    const { token } = await S(anon).addItem(null, a.id, 1);
    await S(anon).addItem(token, b.id, 1);
    await admin.repo('shop.product').update(b.id, { active: false });
    expect((await S(anon).getCart(token)).items.map((i) => i.title)).toEqual(['A']);
  });
});

describe('pricing hook', () => {
  it('applies the setting-driven discount and third-party shop.price filters in order', async () => {
    const mug = await product({ title: 'Mug', price: 10 });
    await kernel.updateModuleSettings(site.id, 'shop', { discount_percent: 10 });
    const ctx = await kernel.context(site.id, null);
    let cart = await S(ctx).addItem(null, mug.id, 2);
    expect(cart).toMatchObject({ subtotal: 20, total: 18, discount: 2 });
    expect(cart.items[0]).toMatchObject({ list: 10, unit: 9 });
    // qty 5 → 10% off (9.00) then bulk 1.00 off (8.00)
    cart = await S(ctx).updateItem(cart.token!, mug.id, 5);
    expect(cart).toMatchObject({ subtotal: 50, total: 40, discount: 10 });
    // min-qty setting gates the store-wide discount
    await kernel.updateModuleSettings(site.id, 'shop', { discount_min_qty: 10 });
    const ctx2 = await kernel.context(site.id, null);
    expect(await S(ctx2).getCart(cart.token)).toMatchObject({ total: 45 });
  });
});

describe('stock', () => {
  it('refuses to add more than is in stock; null stock is unlimited', async () => {
    const limited = await product({ title: 'Limited', price: 5, stock: 2 });
    const unlimited = await product({ title: 'Plenty', price: 5 });
    const { token } = await S(anon).addItem(null, limited.id, 2);
    await expect(S(anon).addItem(token, limited.id, 1)).rejects.toThrow(/Only 2 of "Limited" left/);
    await expect(S(anon).updateItem(token!, limited.id, 3)).rejects.toThrow(ValidationError);
    await S(anon).addItem(token, unlimited.id, 500);
    const sold = await product({ title: 'Gone', price: 5, stock: 0 });
    await expect(S(anon).addItem(token, sold.id, 1)).rejects.toThrow(/out of stock/);
  });

  it('decrements on checkout, fails the second buyer of the last units, and restocks on cancel', async () => {
    const p = await product({ title: 'Last', price: 5, stock: 2 });
    const c1 = await S(anon).addItem(null, p.id, 2);
    const c2 = await S(anon).addItem(null, p.id, 2);
    const first = await api(anon, 'POST', '/checkout', { body: { token: c1.token, email: 'a@x.io' } });
    expect((await admin.repo('shop.product').get(p.id)).stock).toBe(0);
    await expect(api(anon, 'POST', '/checkout', { body: { token: c2.token, email: 'b@x.io' } })).rejects.toThrow(/out of stock/);
    // The failed checkout rolled back completely: no order, cart intact.
    expect(await admin.repo('shop.order').count()).toBe(1);
    expect((await S(anon).getCart(c2.token)).count).toBe(2);

    const cancelled = await api(admin, 'POST', `/orders/${first.order.id}/cancel`);
    expect(cancelled.status).toBe('cancelled');
    expect((await admin.repo('shop.product').get(p.id)).stock).toBe(2);
    await expect(api(admin, 'POST', `/orders/${first.order.id}/cancel`)).rejects.toThrow(/Cannot cancel a cancelled order/);
  });
});

describe('checkout and payment', () => {
  it('checkout → fake provider → confirm → order paid via event; receipt sent; markPaid idempotent', async () => {
    const mug = await product({ title: 'Mug', price: 12.5, stock: 10 });
    const { token } = await S(anon).addItem(null, mug.id, 2);
    await expect(api(anon, 'POST', '/checkout', { body: { token, email: 'not-an-email' } })).rejects.toThrow(/valid email/);

    const res = await api(anon, 'POST', '/checkout', { body: { token, email: 'buyer@x.io', base: '/s/t' }, headers: { Host: 'localhost:3000' } });
    expect(res.order).toMatchObject({ status: 'pending', total: 25, currency: 'USD' });
    expect(res.order.number).toMatch(/^\d{6}-[0-9A-F]{6}$/);
    expect(res.redirect).toMatch(/^\/s\/t\/payments\/fake\/fake_[0-9a-f]+$/);
    expect((await S(anon).getCart(token)).count).toBe(0);

    const order = await admin.repo('shop.order').get(res.order.id);
    expect(order).toMatchObject({ email: 'buyer@x.io', subtotal: 25, discount: 0, total: 25, payment_provider: 'fake' });
    expect(order.items).toEqual([{ product: mug.id, title: 'Mug', sku: null, price: 12.5, list_price: 12.5, qty: 2, line: 25 }]);
    const tx = await admin.repo('payments.transaction').findOne({ order_id: order.id });
    expect(tx).toMatchObject({ provider: 'fake', amount: 25, status: 'pending', ref: order.payment_ref });
    expect(tx!.raw.successUrl).toBe(`http://localhost:3000/s/t/checkout/success?order=${order.id}`);

    // Visitor clicks "Pay now".
    const ref = res.redirect.split('/').pop();
    const pay = await invokeRoute(anon, { surface: 'site', method: 'POST', path: `/payments/fake/${ref}/confirm` });
    expect(pay.headers?.location).toBe(tx!.raw.successUrl);
    expect((await admin.repo('shop.order').get(order.id)).status).toBe('pending'); // async until the outbox runs
    await kernel.drain();

    const paid = await admin.repo('shop.order').get(order.id);
    expect(paid).toMatchObject({ status: 'paid', payment_ref: ref, payment_provider: 'fake' });
    expect(events.filter((e) => e.event === 'shop.order.paid')).toEqual([{ event: 'shop.order.paid', payload: { id: order.id, number: order.number, total: 25, currency: 'USD' } }]);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: 'buyer@x.io' });
    expect(mails[0]!.subject).toContain(order.number);
    expect(mails[0]!.text).toContain('2 x Mug @ 12.50 USD = 25.00 USD');

    // Idempotent: direct call, repeated confirm, and replayed event change nothing.
    expect((await S(anon).markPaid(order.id, { ref: 'other' })).changed).toBe(false);
    await invokeRoute(anon, { module: 'payments', method: 'POST', path: `/fake/${ref}/confirm` });
    await admin.tx((c) => c.emit('payments.succeeded', { ref, orderId: order.id, provider: 'fake' }));
    await kernel.drain();
    expect(events.filter((e) => e.event === 'shop.order.paid')).toHaveLength(1);
    expect(mails).toHaveLength(1);
    expect((await admin.repo('shop.order').get(order.id)).payment_ref).toBe(ref);

    // Success page shows the paid order without leaking the email.
    const success = await invokeRoute(anon, { surface: 'site', method: 'GET', path: '/checkout/success', query: { order: order.id } });
    const html = await renderPage(anon, success.page!.tree, { query: { order: order.id }, base: '/s/t' });
    expect(html).toContain(`Order ${order.number} — paid`);
    expect(html).not.toContain('buyer@x.io');

    // Fulfil (admin), then cancellation is refused.
    expect((await api(admin, 'POST', `/orders/${order.id}/fulfill`)).status).toBe('fulfilled');
    await expect(api(admin, 'POST', `/orders/${order.id}/cancel`)).rejects.toThrow(ValidationError);
  });

  it('checks out through Stripe when configured (mocked fetch)', async () => {
    const mug = await product({ title: 'Mug', price: 7 });
    await kernel.updateModuleSettings(site.id, 'payments', { provider: 'stripe', stripe_secret_key: 'sk_test_1' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'cs_9', url: 'https://checkout.stripe.com/cs_9' })));
    const ctx = await kernel.context(site.id, null);
    const { token } = await S(ctx).addItem(null, mug.id, 3);
    const res = await api(ctx, 'POST', '/checkout', { body: { token, email: 'z@x.io' }, headers: { origin: 'https://shop.example' } });
    expect(res.redirect).toBe('https://checkout.stripe.com/cs_9');
    const form = new URLSearchParams(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(form.get('success_url')).toBe(`https://shop.example/checkout/success?order=${res.order.id}`);
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('700');
    expect((await admin.repo('shop.order').get(res.order.id)).payment_ref).toBe('cs_9');

    // If the provider fails, the order and the stock reservation roll back and the cart survives.
    fetchMock.mockResolvedValueOnce(new Response('{"error":{"message":"down"}}', { status: 500 }));
    const { token: t2 } = await S(ctx).addItem(null, mug.id, 1);
    await expect(api(ctx, 'POST', '/checkout', { body: { token: t2, email: 'z@x.io' }, headers: { origin: 'https://shop.example' } })).rejects.toThrow(/Stripe error: down/);
    expect(await admin.repo('shop.order').count()).toBe(1);
    expect((await S(ctx).getCart(t2)).count).toBe(1);
  });
});

describe('permissions', () => {
  it('anonymous visitors use cart routes but cannot read orders or carts', async () => {
    const mug = await product({ title: 'Mug', price: 1 });
    const cart = await api(anon, 'POST', '/cart/items', { body: { product: mug.id } });
    expect(cart.count).toBe(1);
    await expect(api(anon, 'GET', '/orders')).rejects.toThrow(UnauthorizedError);
    await expect(api(anon, 'POST', '/orders/00000000-0000-0000-0000-000000000000/fulfill')).rejects.toThrow(UnauthorizedError);
    expect(await anon.repo('shop.cart').find().catch((e) => e)).toBeInstanceOf(ForbiddenError);
    await expect(anon.repo('shop.order').find()).rejects.toThrow(ForbiddenError);

    // A signed-in member without shop.manage is forbidden; editors get it by default grant.
    const viewer = await kernel.createUser({ email: 'v@x.io', password: 'password1' });
    await kernel.addMember(site.id, viewer.id, 'viewer');
    await expect(api(await kernel.context(site.id, viewer.id), 'GET', '/orders')).rejects.toThrow(ForbiddenError);
    const editor = await kernel.createUser({ email: 'e@x.io', password: 'password1' });
    await kernel.addMember(site.id, editor.id, 'editor');
    expect(await api(await kernel.context(site.id, editor.id), 'GET', '/orders')).toEqual([]);
  });
});

/* ───────────── rendering ───────────── */

async function renderPage(ctx: SiteContext, tree: PageNode, scope: Record<string, unknown> = {}) {
  const sc = { path: '/', params: {}, query: {}, ...scope };
  const data = await loadData(tree, ctx.runtime.blocks, { siteId: ctx.site.id, scope: sc, services: { ctx } });
  return renderDocument(tree, { registry: ctx.runtime.blocks, theme: kernel.theme(ctx.site), title: 'T', scope: sc, data }).document;
}

describe('rendering', () => {
  it('renders the product grid with products, links under the site base, escaped content and islands', async () => {
    await product({ title: 'Blue <Mug>', price: 12, compare_at: 15, image: 'https://img.test/mug.png' });
    await product({ title: 'Tee', price: 20, stock: 0 });
    await product({ title: 'Secret', price: 1, active: false });
    const tree: PageNode = {
      id: 'root',
      type: 'core:page',
      props: {},
      slots: {
        default: [
          { id: 'cb', type: 'shop:cart-button', props: {} },
          { id: 'g', type: 'shop:product-grid', props: { columns: 4 } },
        ],
      },
    };
    const html = await renderPage(anon, tree, { base: '/s/t', path: '/shop' });
    expect(html).toContain('Blue &lt;Mug&gt;');
    expect(html).not.toContain('<Mug>');
    expect(html).toContain('href="/s/t/shop/blue-mug"');
    expect(html).toContain('<s>$15.00</s>$12.00');
    expect(html).toContain('Sold out');
    expect(html).not.toContain('Secret');
    expect(html).toContain('--shop-cols:4');
    expect(html).toContain('data-island="shop:cart-button"');
    expect(html).toContain('href="/s/t/cart"');
    expect(html).toContain(`data-props="{&quot;base&quot;:&quot;/s/t&quot;}"`);
    expect(html).toMatch(/<script type="module">.*modulo_cart/s);
  });

  it('serves /shop/:slug as a product page using the record in scope', async () => {
    const p = await product({ title: 'Lamp', price: 30, description: '<p>Warm <b>light</b></p><script>alert(1)</script><img src=x onerror="alert(2)">', sku: 'L-1' });
    const res = await invokeRoute(anon, { surface: 'site', method: 'GET', path: '/shop/lamp' });
    expect(res.page!.title).toBe('Lamp');
    expect((res.page!.scope as any).record.id).toBe(p.id);
    const html = await renderPage(anon, res.page!.tree, { ...res.page!.scope, base: '' });
    expect(html).toContain('<h1>Lamp</h1>');
    expect(html).toContain('<p>Warm <b>light</b></p>');
    expect(html).not.toMatch(/alert\(/);
    expect(html).toContain('data-island="shop:add-to-cart"');
    expect(html).toContain(`&quot;product&quot;:&quot;${p.id}&quot;`);
    await expect(invokeRoute(anon, { surface: 'site', method: 'GET', path: '/shop/nope' })).rejects.toThrow(/not found/i);

    const cartPage = await invokeRoute(anon, { surface: 'site', method: 'GET', path: '/cart' });
    const cartHtml = await renderPage(anon, cartPage.page!.tree, { base: '/s/t' });
    expect(cartHtml).toContain('data-island="shop:cart"');
    expect(cartHtml).toContain('&quot;currency&quot;:&quot;USD&quot;');
  });

  it('keeps islands small and patches the layout header', () => {
    for (const src of [ADD_TO_CART, CART_BUTTON, CART_ISLAND]) {
      expect(src.length).toBeLessThan(2048);
      expect(src).not.toContain('innerHTML');
      expect(() => new Function(`return (${src})`)).not.toThrow();
    }
    const patch = shop.patches![0]!;
    expect(patch.template).toBe('core:layout');
    expect(patch.ops.map((o: any) => [o.target, o.node.type])).toEqual([
      ['header#actions', 'shop:cart-button'],
      ['header#nav', 'core:link'],
    ]);
    expect(sanitizeRichText('<a href="javascript:alert(1)" onclick="x()">x</a>')).toBe('<a href="#">x</a>');
  });
});
