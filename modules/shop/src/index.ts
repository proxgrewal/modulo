import { defineModel, f, mf, type PageNode } from '@modulo/core';
import { defineModule, NotFoundError, type RouteRequest, type SiteContext } from '@modulo/kernel';
import { shopBlocks } from './blocks.ts';
import { CART, CATEGORY, ORDER, PRODUCT, shopService, type PriceInput, type ShopService } from './service.ts';
import { baseOf, round2 } from './util.ts';

export * from './service.ts';
export { productCard, priceTag, CARD_CSS } from './blocks.ts';
export { ADD_TO_CART, CART_BUTTON, CART as CART_ISLAND } from './islands.ts';
export { money, sanitizeRichText, baseOf } from './util.ts';

const svc = (ctx: SiteContext) => ctx.service<ShopService>('shop');
const body = (req: RouteRequest) => (req.body && typeof req.body === 'object' ? (req.body as Record<string, any>) : {});

function header(req: RouteRequest, name: string): string | undefined {
  const k = Object.keys(req.headers).find((h) => h.toLowerCase() === name);
  return k ? req.headers[k] : undefined;
}
/** Absolute origin for provider redirect URLs (Stripe requires absolute success/cancel URLs). */
function originOf(req: RouteRequest): string {
  const origin = header(req, 'origin');
  if (origin && /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) return origin;
  const host = header(req, 'x-forwarded-host') ?? header(req, 'host');
  if (host && /^[a-z0-9.-]+(:\d+)?$/i.test(host)) {
    const proto = header(req, 'x-forwarded-proto') === 'https' ? 'https' : 'http';
    return `${proto}://${host}`;
  }
  return '';
}

const page = (children: PageNode[]): PageNode => ({ id: 'root', type: 'core:page', props: {}, slots: { default: children } });

export default defineModule({
  name: 'shop',
  version: '1.0.0',
  label: 'Shop',
  description: 'Products, cart, checkout and orders.',
  kernel: '^1.0.0',
  category: 'commerce',
  depends: { payments: '^1.0.0' },

  models: [
    defineModel({
      name: CATEGORY,
      label: 'Category',
      titleField: 'name',
      order: 'name asc',
      fields: { name: mf.string({ required: true }), slug: mf.slug('name') },
      access: { read: 'public' },
    }),
    defineModel({
      name: PRODUCT,
      label: 'Product',
      titleField: 'title',
      fields: {
        title: mf.string({ required: true }),
        slug: mf.slug('title'),
        description: mf.richtext(),
        price: mf.money({ required: true }),
        compare_at: mf.money({ label: 'Compare-at price' }),
        sku: mf.string({ max: 64 }),
        stock: mf.int({ help: 'Leave empty for unlimited stock' }),
        image: mf.media(),
        category: mf.ref(CATEGORY, { index: true }),
        active: mf.boolean({ default: true, index: true }),
      },
      access: { read: 'public' },
    }),
    defineModel({
      name: CART,
      label: 'Cart',
      titleField: 'token',
      fields: {
        token: mf.string({ required: true, unique: true, max: 64 }),
        items: mf.json({ default: [] }),
        email: mf.email({ private: true }),
      },
      // Visitors reach carts only through the routes below (as sudo, by token).
      access: { read: 'shop.manage', create: 'shop.manage', update: 'shop.manage', delete: 'shop.manage' },
    }),
    defineModel({
      name: ORDER,
      label: 'Order',
      titleField: 'number',
      fields: {
        number: mf.string({ required: true, unique: true, max: 32 }),
        email: mf.email({ private: true }),
        items: mf.json({ default: [] }),
        subtotal: mf.money({ default: 0 }),
        discount: mf.money({ default: 0 }),
        total: mf.money({ default: 0 }),
        currency: mf.string({ max: 3, default: 'USD' }),
        status: mf.enum(['pending', 'paid', 'fulfilled', 'cancelled', 'refunded'], { default: 'pending', index: true }),
        payment_provider: mf.string({ max: 32 }),
        payment_ref: mf.string({ index: true }),
      },
      access: { read: 'shop.manage', create: 'shop.manage', update: 'shop.manage', delete: 'shop.manage' },
    }),
  ],

  permissions: [{ key: 'shop.manage', label: 'Manage products and orders' }],
  grants: { editor: ['shop.manage'] },

  settings: {
    currency: f.select(['USD', 'EUR', 'GBP', 'CAD', 'AUD'], { label: 'Currency' }),
    discount_percent: f.number({ label: 'Store-wide discount (%)', default: 0, min: 0, max: 100 }),
    discount_min_qty: f.number({ label: 'Discount applies from quantity', default: 1, min: 1 }),
  },

  records: [{ key: 'default_category', model: CATEGORY, values: { name: 'General' }, noupdate: true }],

  blocks: shopBlocks,

  patches: [
    {
      id: 'header-cart',
      template: 'core:layout',
      ops: [
        { op: 'append', target: 'header#actions', node: { id: 'shop-cart-button', type: 'shop:cart-button', props: { label: 'Cart' }, origin: 'shop' } },
        { op: 'append', target: 'header#nav', node: { id: 'shop-nav-link', type: 'core:link', props: { label: 'Shop', href: '/shop' }, origin: 'shop' } },
      ],
    },
  ],

  hooks: [
    {
      // Setting-driven store-wide discount, implemented as an ordinary `shop.price` filter;
      // other modules add theirs (after: ['shop']) the same way.
      hook: 'shop.price',
      kind: 'filter',
      id: 'settings-discount',
      fn: (v: PriceInput, ctx: SiteContext) => {
        const s = ctx.settings('shop');
        const pct = Number(s.discount_percent) || 0;
        if (pct <= 0 || v.qty < (Number(s.discount_min_qty) || 1)) return v;
        return { ...v, unit: round2(v.unit * (1 - Math.min(pct, 100) / 100)) };
      },
    },
    {
      // Anonymous visitors (and users without shop.manage) only ever see active products.
      hook: `model.${PRODUCT}.where`,
      kind: 'filter',
      id: 'active-only',
      fn: (where: Record<string, unknown> | undefined, ctx: SiteContext) => (ctx.can('shop.manage') ? where : { ...(where ?? {}), active: true }),
    },
  ],

  services: (ctx) => shopService(ctx) as unknown as Record<string, (...args: any[]) => any>,

  events: [
    {
      event: 'payments.succeeded',
      id: 'mark-paid',
      handler: async (p: { orderId?: string; ref?: string; provider?: string }, ctx) => {
        if (!p?.orderId) return;
        try {
          await shopService(ctx).markPaid(p.orderId, { ref: p.ref, provider: p.provider });
        } catch (e) {
          if (e instanceof NotFoundError) return; // a payment for something other than a shop order
          throw e;
        }
      },
    },
  ],

  jobs: [{ name: 'send-receipt', maxAttempts: 5, handler: async (p: { orderId: string }, ctx) => shopService(ctx).sendReceipt(p.orderId) }],

  routes: [
    /* ───── visitor API (public) ───── */
    { method: 'GET', path: '/cart', surface: 'api', permission: 'public', handler: async ({ ctx, query }) => ({ body: await svc(ctx).getCart(query.token) }) },
    {
      method: 'POST',
      path: '/cart/items',
      surface: 'api',
      permission: 'public',
      handler: async (req) => {
        const b = body(req);
        return { body: await svc(req.ctx).addItem(b.token, b.product, b.qty ?? 1) };
      },
    },
    {
      method: 'PATCH',
      path: '/cart/items/:product',
      surface: 'api',
      permission: 'public',
      handler: async (req) => {
        const b = body(req);
        return { body: await svc(req.ctx).updateItem(b.token ?? req.query.token, req.params.product, b.qty) };
      },
    },
    {
      method: 'DELETE',
      path: '/cart/items/:product',
      surface: 'api',
      permission: 'public',
      handler: async (req) => ({ body: await svc(req.ctx).removeItem(req.query.token ?? body(req).token, req.params.product) }),
    },
    {
      method: 'POST',
      path: '/checkout',
      surface: 'api',
      permission: 'public',
      handler: async (req) => {
        const b = body(req);
        const { order, redirect } = await svc(req.ctx).checkout({ token: b.token, email: b.email, base: baseOf({ base: b.base }), origin: originOf(req) });
        return { status: 201, body: { order: { id: order.id, number: order.number, total: order.total, currency: order.currency, status: order.status }, redirect } };
      },
    },

    /* ───── admin API ───── */
    {
      method: 'GET',
      path: '/orders',
      surface: 'api',
      permission: 'shop.manage',
      handler: async ({ ctx, query }) => ({
        body: await ctx.repo(ORDER).find({ where: query.status ? { status: query.status } : undefined, limit: Number(query.limit) || 50, offset: Number(query.offset) || 0 }),
      }),
    },
    { method: 'GET', path: '/orders/:id', surface: 'api', permission: 'shop.manage', handler: async ({ ctx, params }) => ({ body: await ctx.repo(ORDER).get(params.id!) }) },
    { method: 'POST', path: '/orders/:id/fulfill', surface: 'api', permission: 'shop.manage', handler: async ({ ctx, params }) => ({ body: await svc(ctx).fulfill(params.id!) }) },
    { method: 'POST', path: '/orders/:id/cancel', surface: 'api', permission: 'shop.manage', handler: async ({ ctx, params }) => ({ body: await svc(ctx).cancel(params.id!) }) },

    /* ───── site pages ───── */
    {
      method: 'GET',
      path: '/shop',
      surface: 'site',
      handler: () => ({ page: { title: 'Shop', tree: page([{ id: 'shop-grid', type: 'shop:product-grid', props: { columns: 3, limit: 24, category: '' } }]) } }),
    },
    {
      method: 'GET',
      path: '/shop/:slug',
      surface: 'site',
      handler: async ({ ctx, params }) => {
        const product = await svc(ctx).productBySlug(params.slug!);
        if (!product) throw new NotFoundError('Product not found');
        return { page: { title: product.title, scope: { record: product }, tree: page([{ id: 'shop-detail', type: 'shop:product-detail', props: { product: '', showQty: true } }]) } };
      },
    },
    { method: 'GET', path: '/cart', surface: 'site', handler: () => ({ page: { title: 'Cart', tree: page([{ id: 'shop-cart', type: 'shop:cart', props: {} }]) } }) },
    {
      method: 'GET',
      path: '/checkout/success',
      surface: 'site',
      handler: ({ query }) => ({ page: { title: 'Order confirmation', tree: page([{ id: 'shop-order', type: 'shop:order-status', props: { order: query.order ?? '' } }]) } }),
    },
  ],

  editor: {
    collections: [
      { model: PRODUCT, label: 'Products', icon: 'package', columns: ['title', 'price', 'stock', 'active'] },
      { model: CATEGORY, label: 'Categories', icon: 'folder', columns: ['name', 'slug'] },
      { model: ORDER, label: 'Orders', icon: 'receipt', columns: ['number', 'email', 'total', 'status', 'created_at'] },
    ],
  },
});
