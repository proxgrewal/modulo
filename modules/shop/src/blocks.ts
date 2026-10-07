import { defineBlock, f, h, raw, type VNode } from '@modulo/core';
import type { SiteContext } from '@modulo/kernel';
import { ADD_TO_CART, CART, CART_BUTTON } from './islands.ts';
import { shopService, type ProductView } from './service.ts';
import { baseOf, isUuid, money, sanitizeRichText } from './util.ts';

const svc = (services: Record<string, any>) => shopService(services.ctx as SiteContext);

export const CARD_CSS =
  '.shop-card{display:flex;flex-direction:column;gap:var(--space-sm,.5rem);border:1px solid var(--color-border,#e5e5e5);border-radius:var(--radius-md,8px);overflow:hidden;background:var(--color-surface,#fff)}' +
  '.shop-card a{color:inherit;text-decoration:none;display:flex;flex-direction:column;height:100%}' +
  '.shop-card img,.shop-card .shop-ph{aspect-ratio:1/1;object-fit:cover;width:100%;background:var(--color-muted,#f2f2f2)}' +
  '.shop-card h3{font-size:1rem;margin:var(--space-sm,.5rem) var(--space-md,1rem) 0}' +
  '.shop-price{margin:0 var(--space-md,1rem) var(--space-md,1rem);font-weight:600}.shop-price s{opacity:.6;font-weight:400;margin-right:.4em}' +
  '.shop-soldout{font-size:.8em;opacity:.7;margin-left:.5em}';

/** Price with strike-through when discounted (by `shop.price`) or below compare_at. */
export function priceTag(p: Pick<ProductView, 'price' | 'unit' | 'compare_at'>, currency: string): VNode {
  const was = p.unit < p.price ? p.price : p.compare_at && p.compare_at > p.unit ? p.compare_at : null;
  return h('span', { class: 'shop-price-tag' }, was ? h('s', null, money(was, currency)) : null, money(p.unit, currency));
}

export function productCard(p: ProductView, base: string, currency: string): VNode {
  return h(
    'article',
    { class: 'shop-card' },
    h(
      'a',
      { href: `${base}/shop/${encodeURIComponent(p.slug)}` },
      p.image ? h('img', { src: p.image, alt: p.title, loading: 'lazy' }) : h('div', { class: 'shop-ph' }),
      h('h3', null, p.title),
      h('p', { class: 'shop-price' }, priceTag(p, currency), p.inStock ? null : h('span', { class: 'shop-soldout' }, 'Sold out')),
    ),
  );
}

type GridProps = { columns: number; limit: number; category: string };
type GridData = { products: ProductView[]; currency: string; base: string; __error?: string };

export const productGrid = defineBlock<GridProps, GridData>({
  type: 'shop:product-grid',
  version: 1,
  label: 'Product grid',
  category: 'Shop',
  icon: 'grid',
  description: 'Active products, newest first.',
  fields: {
    columns: f.number({ label: 'Columns', default: 3, min: 1, max: 6 }),
    limit: f.number({ label: 'Max products', default: 12, min: 1, max: 100 }),
    category: f.collection({ label: 'Category (id or slug)', model: 'shop.category', default: '' }),
  },
  css:
    '.shop-grid{display:grid;gap:var(--space-lg,1.5rem);grid-template-columns:repeat(var(--shop-cols,3),minmax(0,1fr))}' +
    '@media (max-width:640px){.shop-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}' +
    CARD_CSS,
  load: async (props, { services, scope }) => {
    const s = svc(services);
    const category = props.category || (typeof (scope.query as any)?.category === 'string' ? (scope.query as any).category : '');
    return { products: await s.listProducts({ limit: props.limit, category }), currency: s.currency(), base: baseOf(scope) };
  },
  render: (props, ctx) => {
    const d = ctx.data;
    const base = d?.base ?? baseOf(ctx.scope);
    const cols = Math.min(Math.max(Math.round(Number(props.columns) || 3), 1), 6);
    if (!d?.products?.length) return ctx.root('div', { class: 'shop-grid shop-empty' }, h('p', null, ctx.mode === 'edit' ? 'No products yet — add some under Products.' : 'No products yet.'));
    return ctx.root('div', { class: 'shop-grid', style: `--shop-cols:${cols}` }, ...d.products.map((p) => productCard(p, base, d.currency)));
  },
});

export const productCardBlock = defineBlock<{ product: string }, { product: ProductView | null; currency: string; base: string }>({
  type: 'shop:product-card',
  version: 1,
  label: 'Product card',
  category: 'Shop',
  internal: true,
  fields: { product: f.collection({ label: 'Product', model: 'shop.product' }) },
  css: CARD_CSS,
  load: async (props, { services, scope }) => {
    const s = svc(services);
    const [product] = isUuid(props.product) ? await s.productsByIds([props.product]) : [];
    return { product: product ?? null, currency: s.currency(), base: baseOf(scope) };
  },
  render: (_props, ctx) => {
    const d = ctx.data;
    if (!d?.product) return ctx.root('div', { class: 'shop-card shop-missing' }, ctx.mode === 'edit' ? 'Choose a product' : '');
    return ctx.root('div', { class: 'shop-card-wrap' }, productCard(d.product, d.base, d.currency));
  },
});

type DetailData = { product: ProductView | null; currency: string; base: string };

export const productDetail = defineBlock<{ product: string; showQty: boolean }, DetailData>({
  type: 'shop:product-detail',
  version: 1,
  label: 'Product details',
  category: 'Shop',
  description: 'Image, title, price, description and add-to-cart for the current product.',
  fields: {
    product: f.collection({ label: 'Product (defaults to the page record)', model: 'shop.product' }),
    showQty: f.boolean({ label: 'Quantity picker', default: true }),
  },
  css:
    '.shop-detail{display:grid;gap:var(--space-xl,2rem);grid-template-columns:repeat(auto-fit,minmax(280px,1fr));align-items:start}' +
    '.shop-detail img{width:100%;border-radius:var(--radius-md,8px)}.shop-detail .shop-price-tag{font-size:1.4rem;font-weight:600}.shop-detail .shop-price-tag s{opacity:.6;font-weight:400;margin-right:.4em}' +
    '.shop-buy{display:flex;gap:var(--space-sm,.5rem);align-items:center;margin:var(--space-md,1rem) 0}.shop-buy input{width:4.5em;padding:.5em}' +
    '.shop-buy button{background:var(--color-primary);color:#fff;border:0;padding:.7em 1.4em;border-radius:var(--radius-sm,6px);font:inherit;cursor:pointer}.shop-buy button:disabled{opacity:.6}',
  island: { name: 'shop:add-to-cart', script: ADD_TO_CART },
  islandProps: (_props, data) => ({ product: data?.product?.inStock ? data.product.id : null, base: data?.base ?? '' }),
  load: async (props, { services, scope }) => {
    const s = svc(services);
    const rec = scope.record as any;
    let product: ProductView | null = null;
    if (props.product && isUuid(props.product)) [product = null] = await s.productsByIds([props.product]);
    else if (rec?.id && rec.slug !== undefined && rec.price !== undefined) product = rec.active === false ? null : await s.productView(rec);
    return { product, currency: s.currency(), base: baseOf(scope) };
  },
  render: (props, ctx) => {
    const p = ctx.data?.product;
    if (!p) return ctx.root('div', { class: 'shop-detail' }, h('p', null, ctx.mode === 'edit' ? 'Product details appear here on product pages.' : 'Product not found.'));
    const cur = ctx.data.currency;
    return ctx.root(
      'div',
      { class: 'shop-detail' },
      h('div', { class: 'shop-detail-media' }, p.image ? h('img', { src: p.image, alt: p.title }) : null),
      h(
        'div',
        { class: 'shop-detail-info' },
        h('h1', null, p.title),
        h('p', null, priceTag(p, cur)),
        p.sku ? h('p', { class: 'shop-sku' }, `SKU: ${p.sku}`) : null,
        p.inStock
          ? h(
              'div',
              { class: 'shop-buy' },
              props.showQty ? h('input', { type: 'number', min: 1, max: p.stock ?? 999, value: 1, 'data-qty': true, 'aria-label': 'Quantity' }) : null,
              h('button', { type: 'button', 'data-add': true }, 'Add to cart'),
            )
          : h('p', { class: 'shop-soldout' }, 'Sold out'),
        h('p', { class: 'shop-msg', 'data-msg': true, role: 'status' }),
        p.description ? h('div', { class: 'shop-desc' }, raw(sanitizeRichText(p.description))) : null,
      ),
    );
  },
});

export const addToCart = defineBlock<{ product: string; label: string }, { product: string | null; base: string }>({
  type: 'shop:add-to-cart',
  version: 1,
  label: 'Add to cart button',
  category: 'Shop',
  fields: {
    product: f.collection({ label: 'Product (defaults to the page record)', model: 'shop.product' }),
    label: f.text({ label: 'Label', default: 'Add to cart' }),
  },
  css: '.shop-add button{background:var(--color-primary);color:#fff;border:0;padding:.7em 1.4em;border-radius:var(--radius-sm,6px);font:inherit;cursor:pointer}',
  island: { name: 'shop:add-to-cart', script: ADD_TO_CART },
  islandProps: (_props, data) => ({ product: data?.product ?? null, base: data?.base ?? '' }),
  load: async (props, { scope }) => {
    const rec = scope.record as any;
    return { product: isUuid(props.product) ? props.product : isUuid(rec?.id) ? rec.id : null, base: baseOf(scope) };
  },
  render: (props, ctx) =>
    ctx.root('div', { class: 'shop-add' }, h('button', { type: 'button', 'data-add': true }, props.label || 'Add to cart'), h('span', { class: 'shop-msg', 'data-msg': true, role: 'status' })),
});

export const cartButton = defineBlock<{ label: string }, { base: string }>({
  type: 'shop:cart-button',
  version: 1,
  label: 'Cart button',
  category: 'Shop',
  fields: { label: f.text({ label: 'Label', default: 'Cart' }) },
  css:
    '.shop-cart-btn{display:inline-flex;gap:.4em;align-items:center;text-decoration:none;color:inherit}' +
    '.shop-cart-btn [data-count]{min-width:1.5em;padding:0 .4em;border-radius:999px;background:var(--color-muted,#eee);text-align:center;font-size:.85em}' +
    '.shop-cart-btn.has-items [data-count]{background:var(--color-primary);color:#fff}',
  island: { name: 'shop:cart-button', script: CART_BUTTON },
  islandProps: (_props, data) => ({ base: data?.base ?? '' }),
  load: async (_props, { scope }) => ({ base: baseOf(scope) }),
  render: (props, ctx) => {
    const base = ctx.data?.base ?? baseOf(ctx.scope);
    return ctx.root('a', { class: 'shop-cart-btn', href: `${base}/cart` }, props.label || 'Cart', h('span', { 'data-count': true }, '0'));
  },
});

export const cartBlock = defineBlock<{ heading: string; empty: string }, { base: string; currency: string }>({
  type: 'shop:cart',
  version: 1,
  label: 'Cart',
  category: 'Shop',
  fields: {
    heading: f.text({ label: 'Heading', default: 'Your cart' }),
    empty: f.text({ label: 'Empty message', default: 'Your cart is empty.' }),
  },
  css:
    '.shop-cart{max-width:44rem;margin:0 auto}.shop-line{display:grid;grid-template-columns:1fr 5em 7em 2em;gap:var(--space-sm,.5rem);align-items:center;padding:var(--space-sm,.5rem) 0;border-bottom:1px solid var(--color-border,#eee)}' +
    '.shop-line input{width:100%;padding:.3em}.shop-line-total{text-align:right}.shop-rm{border:0;background:none;font-size:1.3em;cursor:pointer}' +
    '.shop-cart-total{text-align:right;font-weight:600;font-size:1.2rem;margin:var(--space-md,1rem) 0}' +
    '.shop-checkout{display:flex;gap:var(--space-sm,.5rem);justify-content:flex-end}.shop-checkout input{padding:.6em;min-width:16em}' +
    '.shop-checkout button{background:var(--color-primary);color:#fff;border:0;padding:.7em 1.4em;border-radius:var(--radius-sm,6px);font:inherit;cursor:pointer}',
  island: { name: 'shop:cart', script: CART },
  islandProps: (props, data) => ({ base: data?.base ?? '', currency: data?.currency ?? 'USD', empty: props.empty || 'Your cart is empty.' }),
  load: async (_props, { services, scope }) => ({ base: baseOf(scope), currency: svc(services).currency() }),
  render: (props, ctx) =>
    ctx.root(
      'section',
      { class: 'shop-cart' },
      h('h1', null, props.heading || 'Your cart'),
      h('div', { 'data-lines': true }, h('p', { class: 'shop-empty' }, 'Loading…')),
      h('p', { class: 'shop-cart-total', 'data-total': true }),
      h(
        'form',
        { class: 'shop-checkout', hidden: true },
        h('input', { type: 'email', name: 'email', required: true, placeholder: 'Email for your receipt', autocomplete: 'email' }),
        h('button', { type: 'submit' }, 'Checkout'),
      ),
      h('p', { class: 'shop-msg', 'data-msg': true, role: 'status' }),
    ),
});

type Summary = Awaited<ReturnType<ReturnType<typeof shopService>['orderSummary']>>;

export const orderStatus = defineBlock<{ order: string }, { order: Summary; base: string }>({
  type: 'shop:order-status',
  version: 1,
  label: 'Order confirmation',
  category: 'Shop',
  internal: true,
  fields: { order: f.text({ label: 'Order id (defaults to ?order=)' }) },
  css: '.shop-order{max-width:40rem;margin:0 auto}.shop-order table{width:100%;border-collapse:collapse}.shop-order td{padding:.3em 0;border-bottom:1px solid var(--color-border,#eee)}.shop-order td:last-child{text-align:right}',
  load: async (props, { services, scope }) => {
    const id = props.order || (scope.query as any)?.order;
    return { order: await svc(services).orderSummary(id), base: baseOf(scope) };
  },
  render: (_props, ctx) => {
    const o = ctx.data?.order;
    const base = ctx.data?.base ?? '';
    if (!o) return ctx.root('section', { class: 'shop-order' }, h('h1', null, 'Order not found'), h('p', null, h('a', { href: `${base}/shop` }, 'Continue shopping')));
    const heading = o.status === 'pending' ? 'Thanks! We are confirming your payment…' : o.status === 'cancelled' ? 'This order was cancelled' : 'Thank you for your order!';
    return ctx.root(
      'section',
      { class: 'shop-order', 'data-status': o.status },
      h('h1', null, heading),
      h('p', null, `Order ${o.number} — ${o.status}`),
      h(
        'table',
        null,
        h(
          'tbody',
          null,
          ...(o.items as any[]).map((i) => h('tr', null, h('td', null, `${i.qty} × ${i.title}`), h('td', null, money(i.line, o.currency)))),
          o.discount ? h('tr', null, h('td', null, 'Discount'), h('td', null, `−${money(o.discount, o.currency)}`)) : null,
          h('tr', null, h('td', null, h('strong', null, 'Total')), h('td', null, h('strong', null, money(o.total, o.currency)))),
        ),
      ),
      h('p', null, h('a', { href: `${base}/shop` }, 'Continue shopping')),
    );
  },
});

export const shopBlocks = [productGrid, productCardBlock, productDetail, addToCart, cartButton, cartBlock, orderStatus];
