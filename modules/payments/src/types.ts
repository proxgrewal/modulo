import type { RouteRequest, SiteContext } from '@modulo/kernel';

/** The order fields a provider needs (decoupled from the shop's model). */
export interface CheckoutOrder {
  id: string;
  number?: string;
  email?: string | null;
  total: number;
  currency: string;
  items?: { title: string; price: number; qty: number }[];
}

export interface CreateCheckoutInput {
  order: CheckoutOrder;
  /** Where to send the buyer after paying (absolute for hosted providers like Stripe). */
  successUrl: string;
  cancelUrl: string;
  /** Root-relative site prefix ('' or '/s/slug') for links into the site itself. */
  base?: string;
  ctx: SiteContext;
}

export interface WebhookResult {
  ref: string;
  status: 'succeeded' | 'failed';
}

export interface PaymentProvider {
  id: string;
  label: string;
  createCheckout(input: CreateCheckoutInput): Promise<{ redirect: string; ref: string }>;
  /** Verify and interpret an incoming webhook. Throw on bad signature; return null for ignored events. */
  verifyWebhook?(req: RouteRequest): Promise<WebhookResult | null>;
}

export interface PaymentsService {
  providers(): Promise<PaymentProvider[]>;
  provider(id?: string): Promise<PaymentProvider>;
  checkout(input: Omit<CreateCheckoutInput, 'ctx'> & { provider?: string }): Promise<{ redirect: string; ref: string; provider: string }>;
  markSucceeded(ref: string, raw?: unknown): Promise<{ changed: boolean; transaction: Record<string, any> }>;
  markFailed(ref: string, raw?: unknown): Promise<{ changed: boolean; transaction: Record<string, any> }>;
  transaction(ref: string): Promise<Record<string, any> | null>;
}
