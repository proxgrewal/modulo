import { randomBytes } from 'node:crypto';
import type { PaymentProvider } from '../types.ts';

/**
 * Development provider: "pays" on a site page (/payments/fake/:ref) with a
 * single button. Never use it on a production site.
 */
export const fakeProvider: PaymentProvider = {
  id: 'fake',
  label: 'Test payments (no real money)',
  async createCheckout({ base }) {
    const ref = 'fake_' + randomBytes(12).toString('hex');
    return { ref, redirect: `${base ?? ''}/payments/fake/${ref}` };
  },
};
