import type Stripe from 'stripe';

/** Minimal Stripe objects for specs (only the fields the api reads). */
export function stripeSubscription(
  overrides: Partial<{
    id: string;
    customer: string;
    status: Stripe.Subscription.Status;
    priceId: string;
    workspaceId: string | null;
    periodEnd: number;
    cancelAtPeriodEnd: boolean;
    unitAmount: number | null;
    quantity: number;
  }> = {},
): Stripe.Subscription {
  const o = {
    id: 'sub_123',
    customer: 'cus_123',
    status: 'active' as const,
    priceId: 'price_pro_dummy',
    workspaceId: 'alice' as string | null,
    periodEnd: 1_790_000_000,
    cancelAtPeriodEnd: false,
    unitAmount: 900 as number | null,
    quantity: 1,
    ...overrides,
  };
  return {
    id: o.id,
    object: 'subscription',
    customer: o.customer,
    status: o.status,
    cancel_at_period_end: o.cancelAtPeriodEnd,
    metadata: o.workspaceId ? { workspaceId: o.workspaceId } : {},
    items: {
      object: 'list',
      data: [
        {
          id: 'si_1',
          quantity: o.quantity,
          current_period_end: o.periodEnd,
          price: {
            id: o.priceId,
            unit_amount: o.unitAmount,
            currency: 'usd',
            recurring: { interval: 'month' },
          },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

export function stripeEvent(
  type: string,
  object: Record<string, unknown>,
  id = 'evt_1',
) {
  return {
    id,
    object: 'event',
    type,
    api_version: '2026-11-18.endive',
    created: 1_790_000_000,
    data: { object },
  };
}
