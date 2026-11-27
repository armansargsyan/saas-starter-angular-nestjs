import type { Invoice, PlanStatus } from '@saas-starter/shared';

/** A subscription as the api needs it, independent of the Stripe SDK. */
export interface ProviderSubscription {
  id: string;
  customerId: string;
  status: PlanStatus;
  /** Price of the (single) subscription item. */
  priceId: string | null;
  /** `metadata.workspaceId`, set at checkout. */
  workspaceId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Recurring amount in the smallest currency unit, for MRR stats. */
  amount: number | null;
  currency: string | null;
  interval: 'day' | 'week' | 'month' | 'year' | null;
}

/** A verified webhook event, reduced to what the sync needs. */
export interface ProviderEvent {
  id: string;
  type: string;
  /** The subscription the event is about, when it is about one. */
  subscriptionId: string | null;
  /** Live-mode events are never applied: this app runs in test mode only. */
  livemode: boolean;
}

/** Statuses under which a subscription still grants its plan. */
export const LIVE_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'trialing',
  'past_due',
]);

export class InvalidWebhookSignatureError extends Error {
  constructor() {
    super('Invalid webhook signature');
  }
}

/**
 * Billing operations behind an abstract class, so services and tests never
 * depend on the Stripe SDK (CLAUDE.md: external providers are swappable).
 */
export abstract class BillingProvider {
  abstract createCustomer(params: {
    workspaceId: string;
    email: string | null;
  }): Promise<string>;

  /** Returns the hosted Checkout URL. */
  abstract createCheckoutSession(params: {
    customerId: string;
    priceId: string;
    workspaceId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<string>;

  /** Returns the customer portal URL. */
  abstract createPortalSession(params: {
    customerId: string;
    returnUrl: string;
  }): Promise<string>;

  /** Current state from Stripe (the source of truth); null if it doesn't exist. */
  abstract getSubscription(id: string): Promise<ProviderSubscription | null>;

  /** Expires the customer's open (unpaid) Checkout Sessions. */
  abstract expireOpenCheckoutSessions(customerId: string): Promise<void>;

  /** The customer's subscriptions that still grant a plan (active, trialing, past_due). */
  abstract listLiveSubscriptions(
    customerId: string,
  ): Promise<ProviderSubscription[]>;

  abstract listInvoices(customerId: string, limit: number): Promise<Invoice[]>;

  /**
   * Verifies the `Stripe-Signature` header against the raw body.
   * @throws InvalidWebhookSignatureError
   */
  abstract parseWebhook(rawBody: Buffer, signature: string): ProviderEvent;
}
