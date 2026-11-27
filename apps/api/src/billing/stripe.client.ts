import Stripe from 'stripe';
import type { AppConfigService } from '../config/app-config.service';

export const STRIPE_CLIENT = Symbol('STRIPE_CLIENT');

/**
 * Pinned API version, so Stripe-side upgrades don't change payload shapes
 * under us. The key is test mode only (enforced by the config schema).
 */
export const STRIPE_API_VERSION = '2026-11-18.endive' as const;

export function createStripeClient(config: AppConfigService): Stripe {
  return new Stripe(config.stripe.secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    appInfo: { name: 'saas-starter-angular-nestjs' },
  });
}
