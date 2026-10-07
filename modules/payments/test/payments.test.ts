import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPgliteDb, defineModule, invokeRoute, Kernel, type SiteContext } from '@modulo/kernel';
import payments, {
  formEncode,
  sessionParams,
  signStripePayload,
  stripeProvider,
  verifyStripeSignature,
  type PaymentProvider,
  type PaymentsService,
} from '../src/index.ts';

const SECRET = 'whsec_test_123';

describe('stripe signature verification', () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });
  const now = 1_700_000_000_000;
  const ts = Math.floor(now / 1000);

  it('accepts a valid signature (any of several v1 values)', () => {
    const header = signStripePayload(payload, SECRET, ts);
    expect(verifyStripeSignature(payload, header, SECRET, { now })).toEqual({ ok: true, timestamp: ts });
    const multi = `t=${ts},v1=${'0'.repeat(64)},${header.split(',')[1]}`;
    expect(verifyStripeSignature(payload, multi, SECRET, { now }).ok).toBe(true);
  });

  it('rejects wrong secret, tampered payload, malformed and missing headers', () => {
    const header = signStripePayload(payload, SECRET, ts);
    expect(verifyStripeSignature(payload, header, 'whsec_other', { now })).toEqual({ ok: false, reason: 'signature mismatch' });
    expect(verifyStripeSignature(payload + ' ', header, SECRET, { now })).toEqual({ ok: false, reason: 'signature mismatch' });
    expect(verifyStripeSignature(payload, 'garbage', SECRET, { now }).ok).toBe(false);
    expect(verifyStripeSignature(payload, `t=${ts},v1=zz`, SECRET, { now }).ok).toBe(false);
    expect(verifyStripeSignature(payload, undefined, SECRET, { now }).ok).toBe(false);
    expect(verifyStripeSignature(payload, header, '', { now }).ok).toBe(false);
  });

  it('rejects stale (and far-future) timestamps outside the 5 minute tolerance', () => {
    const stale = signStripePayload(payload, SECRET, ts - 301);
    expect(verifyStripeSignature(payload, stale, SECRET, { now })).toEqual({ ok: false, reason: 'timestamp outside tolerance' });
    expect(verifyStripeSignature(payload, signStripePayload(payload, SECRET, ts - 299), SECRET, { now }).ok).toBe(true);
    expect(verifyStripeSignature(payload, signStripePayload(payload, SECRET, ts + 600), SECRET, { now }).ok).toBe(false);
  });
});

describe('stripe checkout session params', () => {
  it('form-encodes nested params Stripe-style', () => {
    expect(formEncode({ a: 1, b: { c: 'x y' }, l: [{ q: 2 }] })).toEqual(['a=1', 'b%5Bc%5D=x%20y', 'l%5B0%5D%5Bq%5D=2']);
  });
  it('uses item lines when they add up to the total, else one order line', () => {
    const order = { id: 'o1', number: 'N1', total: 25, currency: 'EUR', items: [{ title: 'A', price: 10, qty: 2 }, { title: 'B', price: 5, qty: 1 }] };
    const p = sessionParams({ order, successUrl: 'https://x/s', cancelUrl: 'https://x/c' }) as any;
    expect(p.line_items).toHaveLength(2);
    expect(p.line_items[0]).toEqual({ quantity: 2, price_data: { currency: 'eur', unit_amount: 1000, product_data: { name: 'A' } } });
    const q = sessionParams({ order: { ...order, total: 20 }, successUrl: 'https://x/s', cancelUrl: 'https://x/c' }) as any;
    expect(q.line_items).toEqual([{ quantity: 1, price_data: { currency: 'eur', unit_amount: 2000, product_data: { name: 'Order N1' } } }]);
  });
});

/* ───────────── kernel-backed ───────────── */

let kernel: Kernel;
afterEach(async () => {
  vi.unstubAllGlobals();
  await kernel?.close();
});

const seen: { event: string; payload: any }[] = [];
const listener = defineModule({
  name: 'listener',
  version: '1.0.0',
  kernel: '^1.0.0',
  depends: { payments: '^1.0.0' },
  events: ['payments.succeeded', 'payments.failed'].map((event) => ({ event, handler: (payload: any) => void seen.push({ event, payload }) })),
  hooks: [
    {
      hook: 'payments.providers',
      kind: 'filter',
      fn: (list: PaymentProvider[]) => [...list, { id: 'acme', label: 'Acme Pay', createCheckout: async ({ order }: { order: { id: string } }) => ({ ref: `acme_${order.id}`, redirect: `https://acme.test/pay/${order.id}` }) }],
    },
  ],
});

async function boot() {
  kernel = await Kernel.create({ db: await createPgliteDb(), modules: [payments, listener] });
  const site = await kernel.createSite({ slug: 'p', name: 'P', modules: { payments: '*', listener: '*' } });
  return site;
}
const svc = (ctx: SiteContext) => ctx.service<PaymentsService>('payments');

describe('payments service', () => {
  it('lists built-in and contributed providers; fake checkout + confirm is idempotent', async () => {
    seen.length = 0;
    const site = await boot();
    const anon = await kernel.context(site.id, null);
    expect((await svc(anon).providers()).map((p) => p.id)).toEqual(['fake', 'stripe', 'acme']);
    const r = await svc(anon).checkout({ order: { id: 'order-1', total: 12.5, currency: 'USD' }, successUrl: '/s/p/ok', cancelUrl: '/s/p/cart', base: '/s/p' });
    expect(r.provider).toBe('fake');
    expect(r.redirect).toBe(`/s/p/payments/fake/${r.ref}`);

    // The "Pay now" page renders as a site route.
    const pageRes = await invokeRoute(anon, { surface: 'site', method: 'GET', path: `/payments/fake/${r.ref}` });
    expect(pageRes.page?.tree.slots?.default?.[0]?.type).toBe('payments:fake-checkout');

    const confirm = await invokeRoute(anon, { surface: 'site', method: 'POST', path: `/payments/fake/${r.ref}/confirm` });
    expect(confirm).toMatchObject({ status: 303, headers: { location: '/s/p/ok' } });
    const again = await invokeRoute(anon, { module: 'payments', method: 'POST', path: `/fake/${r.ref}/confirm` });
    expect(again.body).toMatchObject({ ok: true, status: 'succeeded' });
    await kernel.drain();
    expect(seen.filter((s) => s.payload.ref === r.ref)).toHaveLength(1);
    expect(seen[0]!.payload).toMatchObject({ ref: r.ref, orderId: 'order-1', provider: 'fake', amount: 12.5 });

    // Contributed provider is selectable.
    const acme = await svc(anon).checkout({ order: { id: 'order-2', total: 1, currency: 'USD' }, successUrl: '/', cancelUrl: '/', provider: 'acme' });
    expect(acme).toEqual({ ref: 'acme_order-2', redirect: 'https://acme.test/pay/order-2', provider: 'acme' });
    // Non-fake transactions cannot be confirmed through the fake endpoint.
    await expect(invokeRoute(anon, { module: 'payments', method: 'POST', path: `/fake/acme_order-2/confirm` })).rejects.toThrow(/not found/i);
    // Transactions are not readable anonymously.
    await expect(invokeRoute(anon, { module: 'payments', method: 'GET', path: '/transactions' })).rejects.toThrow();
  });

  it('creates Stripe Checkout Sessions with mocked fetch and settles them from a signed webhook', async () => {
    seen.length = 0;
    const site = await boot();
    await kernel.updateModuleSettings(site.id, 'payments', { provider: 'stripe', stripe_secret_key: 'sk_test_abc', stripe_webhook_secret: SECRET });
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const ctx = await kernel.context(site.id, null);
    const order = { id: '7d1f6b9e-1111-4c4c-8888-000000000001', number: 'N-1', email: 'a@b.co', total: 30, currency: 'USD', items: [{ title: 'Mug', price: 15, qty: 2 }] };
    const r = await svc(ctx).checkout({ order, successUrl: 'https://shop.test/ok', cancelUrl: 'https://shop.test/cart' });
    expect(r).toEqual({ ref: 'cs_test_1', redirect: 'https://checkout.stripe.com/c/pay/cs_test_1', provider: 'stripe' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk_test_abc');
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(String(init.body));
    expect(form.get('mode')).toBe('payment');
    expect(form.get('success_url')).toBe('https://shop.test/ok');
    expect(form.get('client_reference_id')).toBe(order.id);
    expect(form.get('customer_email')).toBe('a@b.co');
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('1500');
    expect(form.get('line_items[0][quantity]')).toBe('2');
    expect(form.get('metadata[order_id]')).toBe(order.id);

    // Stripe errors surface as a 502.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401 }));
    await expect(svc(ctx).checkout({ order: { ...order, id: 'x2' }, successUrl: 'https://a/b', cancelUrl: 'https://a/c' })).rejects.toThrow(/Stripe error: Invalid API Key/);

    // Webhook: bad signature is rejected, good one settles (idempotently).
    const event = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', payment_status: 'paid' } } });
    const bad = { module: 'payments', method: 'POST', path: '/webhooks/stripe', body: event, headers: { 'Stripe-Signature': signStripePayload(event, 'whsec_wrong') } };
    await expect(invokeRoute(ctx, bad)).rejects.toThrow(/signature mismatch/);
    const stale = { ...bad, headers: { 'Stripe-Signature': signStripePayload(event, SECRET, Math.floor(Date.now() / 1000) - 3600) } };
    await expect(invokeRoute(ctx, stale)).rejects.toThrow(/tolerance/);
    const good = { ...bad, headers: { 'Stripe-Signature': signStripePayload(event, SECRET) } };
    expect((await invokeRoute(ctx, good)).body).toEqual({ received: true, changed: true });
    expect((await invokeRoute(ctx, good)).body).toEqual({ received: true, changed: false });
    const ignored = JSON.stringify({ id: 'evt_2', type: 'charge.refunded', data: { object: { id: 'ch_1' } } });
    expect((await invokeRoute(ctx, { ...bad, body: ignored, headers: { 'stripe-signature': signStripePayload(ignored, SECRET) } })).body).toMatchObject({ ignored: true });

    await kernel.drain();
    expect(seen.map((s) => s.payload)).toEqual([{ ref: 'cs_test_1', orderId: order.id, provider: 'stripe', amount: 30, currency: 'USD' }]);
    expect((await svc(ctx).transaction('cs_test_1'))!.status).toBe('succeeded');
  });

  it('stripe provider accepts an injected fetch and requires configuration', async () => {
    const site = await boot();
    const ctx = await kernel.context(site.id, null);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'cs_2', url: 'https://stripe.test/2' })));
    const p = stripeProvider({ fetch: fetchMock as any });
    const args = { order: { id: 'o', total: 1, currency: 'USD' }, successUrl: 'https://a/s', cancelUrl: 'https://a/c', ctx };
    await expect(p.createCheckout(args)).rejects.toThrow(/stripe_secret_key/);
    await kernel.updateModuleSettings(site.id, 'payments', { stripe_secret_key: 'sk_test_x' });
    const ctx2 = await kernel.context(site.id, null);
    await expect(p.createCheckout({ ...args, ctx: ctx2, successUrl: '/relative' })).rejects.toThrow(/absolute/);
    expect(await p.createCheckout({ ...args, ctx: ctx2 })).toEqual({ ref: 'cs_2', redirect: 'https://stripe.test/2' });
  });
});
