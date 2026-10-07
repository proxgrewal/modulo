import { randomBytes } from 'node:crypto';
import { tableName } from '@modulo/core';
import { NotFoundError, ValidationError, type Rec, type SiteContext } from '@modulo/kernel';
import { isUuid, round2 } from './util.ts';

export const PRODUCT = 'shop.product';
export const CATEGORY = 'shop.category';
export const CART = 'shop.cart';
export const ORDER = 'shop.order';

export interface CartItem {
  product: string;
  qty: number;
}

/** Value passed through the `shop.price` filter. Return it with a changed `unit`. */
export interface PriceInput {
  unit: number;
  /** List price (product.price), for reference. */
  list: number;
  product: Rec;
  qty: number;
  ctx: SiteContext;
}

export interface PricedLine {
  product: string;
  qty: number;
  title: string;
  slug: string;
  sku: string | null;
  image: string | null;
  stock: number | null;
  /** List price per unit. */
  list: number;
  /** Charged price per unit (after `shop.price`). */
  unit: number;
  line: number;
}

export interface CartView {
  token: string | null;
  email: string | null;
  items: PricedLine[];
  count: number;
  subtotal: number;
  discount: number;
  total: number;
  currency: string;
}

export interface ProductView {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  sku: string | null;
  image: string | null;
  stock: number | null;
  category: string | null;
  price: number;
  unit: number;
  compare_at: number | null;
  inStock: boolean;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
}
export interface ShopMailer {
  send(msg: Mail): Promise<void> | void;
}
/** Default mailer: logs. Replace via the `shop.mailer` filter. */
export const consoleMailer: ShopMailer = {
  send: (msg) => console.log(`[shop mail] to=${msg.to} subject=${msg.subject}\n${msg.text}`),
};

const MAX_QTY = 999;

function checkQty(qty: unknown, allowZero = false): number {
  const n = Number(qty ?? 1);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1) || n > MAX_QTY) throw new ValidationError(`Quantity must be a whole number between ${allowZero ? 0 : 1} and ${MAX_QTY}`);
  return n;
}
function checkProductId(id: unknown): string {
  if (!isUuid(id)) throw new ValidationError('Invalid product id');
  return id;
}
const newToken = () => randomBytes(24).toString('base64url');
const newOrderNumber = () => `${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex').toUpperCase()}`;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ShopService = ReturnType<typeof shopService>;

/**
 * NOTE: inside a transaction always go through the tx-bound service `s` /
 * context `c`: a repo call on a context outside the open transaction starts a
 * second transaction, which deadlocks on PGlite's single connection.
 *
 * Cart, pricing and order logic. Visitor flows run as sudo (carts and orders
 * are not publicly readable); callers enforce permissions at the route level.
 */
export function shopService(ctx: SiteContext) {
  const sudo = ctx.asSudo();
  const settings = () => ctx.settings('shop');
  const currency = () => String(settings().currency || 'USD');
  /** Run fn inside one site transaction with a sudo service bound to it. */
  const inTx = <T>(fn: (s: ShopService, c: SiteContext) => Promise<T>) => sudo.tx((c) => fn(shopService(c), c));

  async function price(product: Rec, qty: number): Promise<{ list: number; unit: number }> {
    const list = round2(Number(product.price ?? 0));
    const out = await ctx.hooks.filter<PriceInput>('shop.price', { unit: list, list, product, qty, ctx }, ctx);
    const unit = Number(out?.unit);
    return { list, unit: round2(Math.max(0, Number.isFinite(unit) ? unit : list)) };
  }

  async function mediaUrl(src: unknown): Promise<string | null> {
    if (!src) return null;
    return String(await ctx.hooks.filter('media.url', String(src), ctx));
  }

  async function productsById(ids: string[], activeOnly = true): Promise<Map<string, Rec>> {
    const valid = [...new Set(ids.filter(isUuid))];
    if (!valid.length) return new Map();
    const rows = await sudo.repo(PRODUCT).find({ where: { id: { in: valid }, ...(activeOnly ? { active: true } : {}) }, limit: 1000 });
    return new Map(rows.map((r) => [r.id, r]));
  }

  async function view(p: Rec): Promise<ProductView> {
    const { list, unit } = await price(p, 1);
    return {
      id: p.id,
      title: p.title,
      slug: p.slug,
      description: p.description ?? null,
      sku: p.sku ?? null,
      image: await mediaUrl(p.image),
      stock: p.stock ?? null,
      category: p.category ?? null,
      price: list,
      unit,
      compare_at: p.compare_at ?? null,
      inStock: p.stock === null || p.stock === undefined || p.stock > 0,
    };
  }

  async function priceItems(items: CartItem[]): Promise<Omit<CartView, 'token' | 'email'>> {
    const products = await productsById(items.map((i) => i.product));
    const lines: PricedLine[] = [];
    for (const it of items) {
      const p = products.get(it.product);
      if (!p) continue; // deleted or deactivated products drop out of the cart
      const { list, unit } = await price(p, it.qty);
      lines.push({
        product: p.id,
        qty: it.qty,
        title: p.title,
        slug: p.slug,
        sku: p.sku ?? null,
        image: await mediaUrl(p.image),
        stock: p.stock ?? null,
        list,
        unit,
        line: round2(unit * it.qty),
      });
    }
    const subtotal = round2(lines.reduce((s, l) => s + l.list * l.qty, 0));
    const total = round2(lines.reduce((s, l) => s + l.line, 0));
    return { items: lines, count: lines.reduce((s, l) => s + l.qty, 0), subtotal, discount: round2(subtotal - total), total, currency: currency() };
  }

  const cartRecord = (token: unknown) => (typeof token === 'string' && token.length >= 16 && token.length <= 64 ? sudo.repo(CART).findOne({ token }) : Promise.resolve(null));
  const itemsOf = (cart: Rec | null): CartItem[] => (Array.isArray(cart?.items) ? cart!.items : []).filter((i: any) => isUuid(i?.product) && Number.isInteger(i?.qty) && i.qty > 0);

  async function cartView(cart: Rec | null): Promise<CartView> {
    return { token: cart?.token ?? null, email: cart?.email ?? null, ...(await priceItems(itemsOf(cart))) };
  }

  async function assertStock(productId: string, qty: number) {
    const p = (await productsById([productId])).get(productId);
    if (!p) throw new NotFoundError('Product not found');
    if (p.stock !== null && p.stock !== undefined && qty > p.stock) {
      throw new ValidationError(p.stock > 0 ? `Only ${p.stock} of "${p.title}" left in stock` : `"${p.title}" is out of stock`);
    }
    return p;
  }

  async function writeItems(token: unknown, mutate: (items: CartItem[], s: ShopService) => Promise<CartItem[]>, create = false): Promise<CartView> {
    return inTx(async (s, c) => {
      const repo = c.repo(CART);
      let cart = await (typeof token === 'string' && token.length >= 16 && token.length <= 64 ? repo.findOne({ token }) : null);
      if (!cart) {
        if (!create) throw new NotFoundError('Cart not found');
        cart = await repo.create({ token: newToken(), items: [] });
      }
      const items = await mutate(itemsOf(cart).map((i) => ({ ...i })), s);
      const updated = await repo.update(cart.id, { items });
      return s.cartView(updated);
    });
  }

  return {
    price,
    priceItems,
    assertStock,
    cartView,
    currency,

    /* ───────────── catalog ───────────── */

    async listProducts(opts: { limit?: number; category?: string; search?: string } = {}): Promise<ProductView[]> {
      const where: Record<string, unknown> = { active: true };
      if (opts.category) {
        const cat = isUuid(opts.category) ? { id: opts.category } : { slug: opts.category };
        const c = await sudo.repo(CATEGORY).findOne(cat);
        if (!c) return [];
        where.category = c.id;
      }
      const rows = await sudo.repo(PRODUCT).find({ where, limit: Math.min(Math.max(Number(opts.limit) || 12, 1), 200), order: 'created_at desc', search: opts.search });
      return Promise.all(rows.map(view));
    },
    async productsByIds(ids: unknown): Promise<ProductView[]> {
      const list = Array.isArray(ids) ? ids.filter(isUuid) : [];
      const map = await productsById(list);
      return Promise.all(list.filter((id) => map.has(id)).map((id) => view(map.get(id)!)));
    },
    async productBySlug(slug: string): Promise<Rec | null> {
      return sudo.repo(PRODUCT).findOne({ slug, active: true });
    },
    productView: view,

    /* ───────────── cart ───────────── */

    async getCart(token?: string | null): Promise<CartView> {
      return cartView(await cartRecord(token));
    },
    async addItem(token: string | null | undefined, product: unknown, qty: unknown = 1): Promise<CartView> {
      const id = checkProductId(product);
      const n = checkQty(qty);
      return writeItems(
        token,
        async (items, s) => {
          const existing = items.find((i) => i.product === id);
          const next = (existing?.qty ?? 0) + n;
          checkQty(next);
          await s.assertStock(id, next);
          if (existing) existing.qty = next;
          else items.push({ product: id, qty: n });
          return items;
        },
        true,
      );
    },
    async updateItem(token: string, product: unknown, qty: unknown): Promise<CartView> {
      const id = checkProductId(product);
      const n = checkQty(qty, true);
      return writeItems(token, async (items, s) => {
        if (n === 0) return items.filter((i) => i.product !== id);
        const existing = items.find((i) => i.product === id);
        if (!existing) throw new NotFoundError('Product is not in the cart');
        await s.assertStock(id, n);
        existing.qty = n;
        return items;
      });
    },
    async removeItem(token: string, product: unknown): Promise<CartView> {
      const id = checkProductId(product);
      return writeItems(token, async (items) => items.filter((i) => i.product !== id));
    },
    async clear(token: string): Promise<CartView> {
      return writeItems(token, async () => []);
    },
    totals: priceItems,

    /* ───────────── stock ───────────── */

    /** Decrement stock for lines, locking the product rows; throws ValidationError if any is short. */
    async decrementStock(lines: { product: string; qty: number; title?: string }[]): Promise<void> {
      return inTx(async (_s, c) => {
        const ids = lines.map((l) => l.product).filter(isUuid);
        if (!ids.length) return;
        // Row locks so concurrent checkouts can't both take the last unit.
        await c.db.query(`SELECT id FROM ${tableName(PRODUCT)} WHERE site_id = $1 AND id = ANY($2) FOR UPDATE`, [c.site.id, ids]);
        const repo = c.repo(PRODUCT);
        for (const l of lines) {
          const p = await repo.findOne({ id: l.product });
          if (!p) throw new ValidationError(`"${l.title ?? l.product}" is no longer available`);
          if (p.stock === null || p.stock === undefined) continue;
          if (p.stock < l.qty) throw new ValidationError(p.stock > 0 ? `Only ${p.stock} of "${p.title}" left in stock` : `"${p.title}" is out of stock`);
          await repo.update(p.id, { stock: p.stock - l.qty });
        }
      });
    },
    async restock(lines: { product: string; qty: number }[]): Promise<void> {
      return inTx(async (_s, c) => {
        const repo = c.repo(PRODUCT);
        for (const l of lines) {
          if (!isUuid(l.product)) continue;
          const p = await repo.findOne({ id: l.product });
          if (p && p.stock !== null && p.stock !== undefined) await repo.update(p.id, { stock: p.stock + l.qty });
        }
      });
    },

    /* ───────────── orders ───────────── */

    /** Snapshot the cart into a pending order, reserve stock and empty the cart. */
    async createOrderFromCart(token: string, email: unknown): Promise<Rec> {
      const mail = String(email ?? '').trim();
      if (!EMAIL_RE.test(mail) || mail.length > 254) throw new ValidationError('A valid email address is required');
      return inTx(async (s, c) => {
        const cart = await c.repo(CART).findOne({ token: String(token ?? '') });
        if (!cart) throw new NotFoundError('Cart not found');
        const v = await s.cartView(cart);
        if (!v.items.length) throw new ValidationError('Your cart is empty');
        await s.decrementStock(v.items);
        const order = await c.repo(ORDER).create({
          number: newOrderNumber(),
          email: mail,
          items: v.items.map((l) => ({ product: l.product, title: l.title, sku: l.sku, price: l.unit, list_price: l.list, qty: l.qty, line: l.line })),
          subtotal: v.subtotal,
          discount: v.discount,
          total: v.total,
          currency: v.currency,
          status: 'pending',
        });
        await c.repo(CART).update(cart.id, { items: [], email: mail });
        await c.emit('shop.order.placed', { id: order.id, number: order.number, total: order.total });
        return order;
      });
    },

    /** Create the order and a payment session in one transaction. */
    async checkout(input: { token: string; email: unknown; base?: string; origin?: string; provider?: string }): Promise<{ order: Rec; redirect: string }> {
      return inTx(async (s, c) => {
        const order = await s.createOrderFromCart(input.token, input.email);
        const root = `${input.origin ?? ''}${input.base ?? ''}`;
        const pay = await c.service<any>('payments').checkout({
          order: { id: order.id, number: order.number, email: order.email, total: order.total, currency: order.currency, items: order.items },
          successUrl: `${root}/checkout/success?order=${order.id}`,
          cancelUrl: `${root}/cart`,
          base: input.base ?? '',
          provider: input.provider,
        });
        const updated = await c.repo(ORDER).update(order.id, { payment_provider: pay.provider, payment_ref: pay.ref });
        return { order: updated, redirect: pay.redirect };
      });
    },

    /** pending → paid. Idempotent: repeated calls (webhook retries) change nothing. */
    async markPaid(orderId: string, info: { provider?: string; ref?: string } = {}): Promise<{ order: Rec; changed: boolean }> {
      return inTx(async (_s, c) => {
        const repo = c.repo(ORDER);
        const order = await repo.get(orderId);
        if (order.status !== 'pending') return { order, changed: false };
        const updated = await repo.update(order.id, {
          status: 'paid',
          ...(info.provider ? { payment_provider: info.provider } : {}),
          ...(info.ref ? { payment_ref: info.ref } : {}),
        });
        await c.emit('shop.order.paid', { id: updated.id, number: updated.number, total: updated.total, currency: updated.currency });
        await c.enqueue('shop', 'send-receipt', { orderId: updated.id });
        return { order: updated, changed: true };
      });
    },
    async fulfill(orderId: string): Promise<Rec> {
      return inTx(async (_s, c) => {
        const repo = c.repo(ORDER);
        const order = await repo.get(orderId);
        if (order.status !== 'paid') throw new ValidationError(`Only paid orders can be fulfilled (order is ${order.status})`);
        const updated = await repo.update(order.id, { status: 'fulfilled' });
        await c.emit('shop.order.fulfilled', { id: order.id, number: order.number });
        return updated;
      });
    },
    /** Cancel a pending or paid order and put its stock back. (Refunds are the provider's business.) */
    async cancel(orderId: string): Promise<Rec> {
      return inTx(async (s, c) => {
        const repo = c.repo(ORDER);
        const order = await repo.get(orderId);
        if (!['pending', 'paid'].includes(order.status)) throw new ValidationError(`Cannot cancel a ${order.status} order`);
        await s.restock(Array.isArray(order.items) ? order.items : []);
        const updated = await repo.update(order.id, { status: 'cancelled' });
        await c.emit('shop.order.cancelled', { id: order.id, number: order.number, wasPaid: order.status === 'paid' });
        return updated;
      });
    },
    /** Public-safe order summary (no email) for the success page. */
    async orderSummary(orderId: unknown) {
      if (!isUuid(orderId)) return null;
      const o = await sudo.repo(ORDER).findOne({ id: orderId });
      if (!o) return null;
      return { id: o.id, number: o.number, status: o.status, items: o.items ?? [], subtotal: o.subtotal, discount: o.discount, total: o.total, currency: o.currency };
    },
    async sendReceipt(orderId: string) {
      const o = await sudo.repo(ORDER).get(orderId);
      if (!o.email) return;
      const mailer = await ctx.hooks.filter<ShopMailer>('shop.mailer', consoleMailer, ctx);
      const fmt = (n: number) => `${Number(n).toFixed(2)} ${o.currency}`;
      const lines = (o.items ?? []).map((i: any) => `  ${i.qty} x ${i.title} @ ${fmt(i.price)} = ${fmt(i.line)}`);
      await mailer.send({
        to: o.email,
        subject: `Receipt for order ${o.number} — ${ctx.site.name}`,
        text: [`Thanks for your order ${o.number}!`, '', ...lines, '', o.discount ? `Discount: -${fmt(o.discount)}` : '', `Total: ${fmt(o.total)}`].filter((l) => l !== '').join('\n'),
      });
    },
  };
}
