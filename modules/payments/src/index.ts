import { defineBlock, defineModel, f, h, mf, type PageNode } from '@modulo/core';
import { defineModule, NotFoundError, ValidationError, type SiteContext } from '@modulo/kernel';
import { fakeProvider } from './providers/fake.ts';
import { stripeProvider } from './providers/stripe.ts';
import type { PaymentProvider, PaymentsService } from './types.ts';

export * from './types.ts';
export { fakeProvider } from './providers/fake.ts';
export { stripeProvider, verifyStripeSignature, signStripePayload, sessionParams, formEncode } from './providers/stripe.ts';

const TX = 'payments.transaction';

/** Built-in providers; other modules add theirs through the `payments.providers` filter. */
const builtins = (): PaymentProvider[] => [fakeProvider, stripeProvider()];

export function paymentsService(ctx: SiteContext): PaymentsService {
  const sudo = ctx.asSudo();
  const providers = async () => (await ctx.hooks.filter<PaymentProvider[]>('payments.providers', builtins(), ctx)).filter((p) => p && p.id);
  const provider = async (id?: string) => {
    const want = id || String(ctx.settings('payments').provider || 'fake');
    const p = (await providers()).find((x) => x.id === want);
    if (!p) throw new ValidationError(`Unknown payment provider "${want}"`);
    return p;
  };
  const transaction = (ref: string) => sudo.repo(TX).findOne({ ref });

  const setStatus = (status: 'succeeded' | 'failed') => async (ref: string, raw?: unknown) =>
    sudo.tx(async (c) => {
      const repo = c.repo(TX);
      const tx = await repo.findOne({ ref });
      if (!tx) throw new NotFoundError(`Payment ${ref} not found`);
      // Idempotent: providers retry webhooks; a settled transaction never changes again.
      if (tx.status !== 'pending') return { changed: false, transaction: tx };
      const updated = await repo.update(tx.id, { status, raw: { ...(tx.raw ?? {}), ...(raw !== undefined ? { [status]: raw } : {}) } });
      await c.emit(`payments.${status}`, { ref, orderId: tx.order_id, provider: tx.provider, amount: tx.amount, currency: tx.currency });
      return { changed: true, transaction: updated };
    });

  return {
    providers,
    provider,
    transaction,
    async checkout({ order, successUrl, cancelUrl, base, provider: pid }) {
      if (!order?.id) throw new ValidationError('checkout() needs an order with an id');
      if (!(Number(order.total) >= 0)) throw new ValidationError('Order total must be a non-negative number');
      const p = await provider(pid);
      const { redirect, ref } = await p.createCheckout({ order, successUrl, cancelUrl, base: base ?? '', ctx });
      await sudo.repo(TX).create({
        ref,
        provider: p.id,
        amount: Number(order.total),
        currency: order.currency,
        status: 'pending',
        order_id: order.id,
        raw: { successUrl, cancelUrl },
      });
      return { redirect, ref, provider: p.id };
    },
    markSucceeded: setStatus('succeeded'),
    markFailed: setStatus('failed'),
  };
}

const svc = (ctx: SiteContext) => ctx.service<PaymentsService>('payments');

/** Only the fake provider may be "paid" by a public button click. */
async function confirmFake(ctx: SiteContext, ref: string) {
  const tx = await svc(ctx).transaction(ref);
  if (!tx || tx.provider !== 'fake') throw new NotFoundError('Payment not found');
  await svc(ctx).markSucceeded(ref, { confirmedAt: new Date().toISOString() });
  return (await svc(ctx).transaction(ref))!;
}

const page = (children: PageNode[]): PageNode => ({ id: 'root', type: 'core:page', props: {}, slots: { default: children } });

const fakeCheckout = defineBlock<{ ref: string }, { tx: Record<string, any> | null; base: string }>({
  type: 'payments:fake-checkout',
  version: 1,
  label: 'Test payment',
  internal: true,
  fields: { ref: f.text() },
  css:
    '.pay-fake{max-width:28rem;margin:var(--space-xl,2rem) auto;padding:var(--space-lg,1.5rem);border:1px solid var(--color-border,#ddd);border-radius:var(--radius-md,8px)}' +
    '.pay-fake button{background:var(--color-primary);color:#fff;border:0;padding:.7em 1.4em;border-radius:var(--radius-sm,6px);font:inherit;cursor:pointer}',
  load: async (props, { services, scope }) => {
    const ctx = services.ctx as SiteContext;
    return { tx: props.ref ? await svc(ctx).transaction(props.ref) : null, base: String(scope.base ?? '') };
  },
  render: (props, ctx) => {
    const tx = ctx.data?.tx;
    const base = ctx.data?.base ?? String(ctx.scope.base ?? '');
    if (!tx) return ctx.root('div', { class: 'pay-fake' }, h('p', null, 'Payment not found.'));
    const amount = fmt(tx.amount, tx.currency);
    if (tx.status !== 'pending')
      return ctx.root('div', { class: 'pay-fake' }, h('h2', null, `Payment ${tx.status}`), h('p', null, h('a', { href: tx.raw?.successUrl ?? `${base}/` }, 'Continue')));
    return ctx.root(
      'div',
      { class: 'pay-fake' },
      h('h2', null, 'Test payment'),
      h('p', null, 'This is the built-in test provider. No real money moves.'),
      h('p', null, h('strong', null, amount)),
      h('form', { method: 'post', action: `${base}/payments/fake/${encodeURIComponent(props.ref)}/confirm` }, h('button', { type: 'submit' }, 'Pay now')),
      tx.raw?.cancelUrl ? h('p', null, h('a', { href: tx.raw.cancelUrl }, 'Cancel')) : null,
    );
  },
});

export function fmt(amount: number, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(Number(amount));
  } catch {
    return `${Number(amount).toFixed(2)} ${currency}`;
  }
}

export default defineModule({
  name: 'payments',
  version: '1.0.0',
  label: 'Payments',
  description: 'Pluggable payment providers (test provider and Stripe Checkout built in).',
  kernel: '^1.0.0',
  category: 'commerce',
  models: [
    defineModel({
      name: TX,
      label: 'Payment transaction',
      titleField: 'ref',
      fields: {
        ref: mf.string({ required: true, unique: true }),
        provider: mf.string({ required: true }),
        amount: mf.money({ required: true }),
        currency: mf.string({ max: 3 }),
        status: mf.enum(['pending', 'succeeded', 'failed'], { default: 'pending', index: true }),
        order_id: mf.string({ index: true }),
        raw: mf.json({ private: true }),
      },
      access: { read: 'payments.manage', create: 'payments.manage', update: 'payments.manage', delete: 'payments.manage' },
    }),
  ],
  permissions: [{ key: 'payments.manage', label: 'Manage payments' }],
  settings: {
    provider: f.select(['fake', 'stripe'], { label: 'Payment provider' }),
    stripe_secret_key: f.text({ label: 'Stripe secret key', help: 'sk_live_… / sk_test_…' }),
    stripe_webhook_secret: f.text({ label: 'Stripe webhook signing secret', help: 'whsec_…' }),
  },
  blocks: [fakeCheckout],
  services: (ctx) => paymentsService(ctx) as unknown as Record<string, (...args: any[]) => any>,
  routes: [
    {
      method: 'GET',
      path: '/providers',
      surface: 'api',
      permission: 'auth',
      handler: async ({ ctx }) => ({ body: (await svc(ctx).providers()).map((p) => ({ id: p.id, label: p.label, webhooks: !!p.verifyWebhook })) }),
    },
    {
      method: 'GET',
      path: '/transactions',
      surface: 'api',
      permission: 'payments.manage',
      handler: async ({ ctx, query }) => ({ body: await ctx.repo(TX).find({ where: query.order ? { order_id: query.order } : undefined, limit: 100 }) }),
    },
    {
      // Generic webhook endpoint: POST /api/sites/:site/m/payments/webhooks/stripe (or any provider id).
      method: 'POST',
      path: '/webhooks/:provider',
      surface: 'api',
      permission: 'public',
      handler: async (req) => {
        const p = await svc(req.ctx).provider(req.params.provider);
        if (!p.verifyWebhook) throw new NotFoundError(`Provider ${p.id} does not accept webhooks`);
        const result = await p.verifyWebhook(req);
        if (!result) return { body: { received: true, ignored: true } };
        const tx = await svc(req.ctx).transaction(result.ref);
        if (!tx || tx.provider !== p.id) return { body: { received: true, unknown: true } };
        const r = result.status === 'succeeded' ? await svc(req.ctx).markSucceeded(result.ref, { webhook: true }) : await svc(req.ctx).markFailed(result.ref, { webhook: true });
        return { body: { received: true, changed: r.changed } };
      },
    },
    {
      method: 'POST',
      path: '/fake/:ref/confirm',
      surface: 'api',
      permission: 'public',
      handler: async ({ ctx, params }) => {
        const tx = await confirmFake(ctx, params.ref!);
        return { body: { ok: true, status: tx.status, redirect: tx.raw?.successUrl ?? null } };
      },
    },
    {
      method: 'GET',
      path: '/payments/fake/:ref',
      surface: 'site',
      handler: ({ params }) => ({ page: { title: 'Test payment', tree: page([{ id: 'pay', type: 'payments:fake-checkout', props: { ref: params.ref } }]) } }),
    },
    {
      method: 'POST',
      path: '/payments/fake/:ref/confirm',
      surface: 'site',
      handler: async ({ ctx, params }) => {
        const tx = await confirmFake(ctx, params.ref!);
        return { status: 303, headers: { location: tx.raw?.successUrl ?? '/' }, body: '' };
      },
    },
  ],
  editor: { collections: [{ model: TX, label: 'Payments', columns: ['ref', 'provider', 'amount', 'status', 'order_id'] }] },
});
