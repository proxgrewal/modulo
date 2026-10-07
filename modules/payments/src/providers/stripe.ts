import { createHmac, timingSafeEqual } from 'node:crypto';
import { ModuloError, ValidationError, type RouteRequest } from '@modulo/kernel';
import type { CreateCheckoutInput, PaymentProvider, WebhookResult } from '../types.ts';

export const STRIPE_API = 'https://api.stripe.com/v1';
/** Default signature tolerance (seconds), same as Stripe's SDKs. */
export const STRIPE_TOLERANCE = 300;

/** Flatten nested objects/arrays into Stripe's bracketed form encoding. */
export function formEncode(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => out.push(...(typeof item === 'object' && item ? formEncode(item as any, `${key}[${i}]`) : [`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`])));
    else if (typeof v === 'object') out.push(...formEncode(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

const cents = (n: number) => Math.round(Number(n) * 100);

/** Build the Checkout Session params for an order. */
export function sessionParams({ order, successUrl, cancelUrl }: Omit<CreateCheckoutInput, 'ctx' | 'base'>): Record<string, unknown> {
  const currency = (order.currency || 'USD').toLowerCase();
  const items = order.items ?? [];
  const sum = items.reduce((s, i) => s + cents(i.price) * i.qty, 0);
  // Line items must add up to the charged total; otherwise charge one "Order" line.
  const line_items =
    items.length && sum === cents(order.total)
      ? items.map((i) => ({ quantity: i.qty, price_data: { currency, unit_amount: cents(i.price), product_data: { name: i.title } } }))
      : [{ quantity: 1, price_data: { currency, unit_amount: cents(order.total), product_data: { name: `Order ${order.number ?? order.id}` } } }];
  return {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: order.id,
    customer_email: order.email ?? undefined,
    metadata: { order_id: order.id, order_number: order.number },
    line_items,
  };
}

/**
 * Verify a `Stripe-Signature` header (t=<unix>,v1=<hex hmac>[,v1=...]):
 * HMAC-SHA256(secret, `${t}.${payload}`), constant-time compared, within tolerance.
 */
export function verifyStripeSignature(
  payload: string,
  header: string | undefined,
  secret: string,
  opts: { tolerance?: number; now?: number } = {},
): { ok: true; timestamp: number } | { ok: false; reason: string } {
  if (!secret) return { ok: false, reason: 'webhook secret not configured' };
  if (!header) return { ok: false, reason: 'missing Stripe-Signature header' };
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.trim().split('=', 2);
    if (k === 't' && v && /^\d+$/.test(v)) t = Number(v);
    else if (k === 'v1' && v) sigs.push(v);
  }
  if (t === null || !sigs.length) return { ok: false, reason: 'malformed Stripe-Signature header' };
  const expected = createHmac('sha256', secret).update(`${t}.${payload}`, 'utf8').digest();
  const match = sigs.some((s) => {
    if (!/^[0-9a-f]+$/i.test(s) || s.length !== expected.length * 2) return false;
    return timingSafeEqual(Buffer.from(s, 'hex'), expected);
  });
  if (!match) return { ok: false, reason: 'signature mismatch' };
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (Math.abs(now - t) > (opts.tolerance ?? STRIPE_TOLERANCE)) return { ok: false, reason: 'timestamp outside tolerance' };
  return { ok: true, timestamp: t };
}

/** Sign a payload like Stripe does (tests / local tooling). */
export function signStripePayload(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex')}`;
}

function header(req: RouteRequest, name: string): string | undefined {
  const k = Object.keys(req.headers).find((h) => h.toLowerCase() === name);
  return k ? req.headers[k] : undefined;
}

/** Raw request body: signature checks need the exact bytes Stripe sent. */
export function rawBody(req: RouteRequest): string {
  const r = (req as any).rawBody;
  if (typeof r === 'string') return r;
  if (r instanceof Uint8Array) return Buffer.from(r).toString('utf8');
  if (typeof req.body === 'string') return req.body;
  return JSON.stringify(req.body ?? {});
}

export interface StripeOptions {
  /** Injected fetch (defaults to the global one at call time). */
  fetch?: typeof fetch;
  now?: () => number;
}

export function stripeProvider(opts: StripeOptions = {}): PaymentProvider {
  return {
    id: 'stripe',
    label: 'Stripe Checkout',
    async createCheckout({ order, successUrl, cancelUrl, ctx }) {
      const key = String(ctx.settings('payments').stripe_secret_key ?? '');
      if (!key) throw new ValidationError('Stripe is not configured (missing stripe_secret_key)');
      if (!/^https?:\/\//.test(successUrl) || !/^https?:\/\//.test(cancelUrl)) throw new ValidationError('Stripe needs absolute success/cancel URLs');
      const doFetch = opts.fetch ?? globalThis.fetch;
      const res = await doFetch(`${STRIPE_API}/checkout/sessions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/x-www-form-urlencoded',
          'idempotency-key': `modulo-${ctx.site.id}-${order.id}`,
        },
        body: formEncode(sessionParams({ order, successUrl, cancelUrl })).join('&'),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.id || !data?.url) throw new ModuloError(`Stripe error: ${data?.error?.message ?? res.status}`, 502, 'payment_provider');
      return { ref: String(data.id), redirect: String(data.url) };
    },
    async verifyWebhook(req): Promise<WebhookResult | null> {
      const secret = String(req.ctx.settings('payments').stripe_webhook_secret ?? '');
      const payload = rawBody(req);
      const v = verifyStripeSignature(payload, header(req, 'stripe-signature'), secret, { now: opts.now?.() });
      if (!v.ok) throw new ValidationError(`Invalid Stripe webhook: ${v.reason}`);
      let event: any;
      try {
        event = JSON.parse(payload);
      } catch {
        throw new ValidationError('Invalid Stripe webhook: body is not JSON');
      }
      const obj = event?.data?.object ?? {};
      switch (event?.type) {
        case 'checkout.session.completed':
          // Delayed payment methods complete with payment_status "unpaid"; wait for async_payment_succeeded.
          return obj.payment_status === 'unpaid' ? null : { ref: String(obj.id), status: 'succeeded' };
        case 'checkout.session.async_payment_succeeded':
          return { ref: String(obj.id), status: 'succeeded' };
        case 'checkout.session.async_payment_failed':
        case 'checkout.session.expired':
          return { ref: String(obj.id), status: 'failed' };
        default:
          return null;
      }
    },
  };
}
