import { Inject, Injectable } from '@nestjs/common';
import {
  type Invoice,
  PLAN_STATUSES,
  type PlanStatus,
} from '@saas-starter/shared';
import type Stripe from 'stripe';
import { AppConfigService } from '../config/app-config.service';
import {
  BillingProvider,
  InvalidWebhookSignatureError,
  LIVE_STATUSES,
  type ProviderEvent,
  type ProviderSubscription,
} from './billing.provider';
import { STRIPE_CLIENT } from './stripe.client';

/** Events that can change a subscription; everything else is acknowledged and ignored. */
export const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

@Injectable()
export class StripeBillingProvider extends BillingProvider {
  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    private readonly config: AppConfigService,
  ) {
    super();
  }

  async createCustomer(params: {
    workspaceId: string;
    email: string | null;
  }): Promise<string> {
    const customer = await this.stripe.customers.create(
      {
        ...(params.email && { email: params.email }),
        metadata: { workspaceId: params.workspaceId },
      },
      // Retried requests (e.g. a double click) reuse the same customer. The
      // email is part of the key: same key + different params is an error.
      {
        idempotencyKey: `customer:${params.workspaceId}:${params.email ?? ''}`,
      },
    );
    return customer.id;
  }

  async createCheckoutSession(params: {
    customerId: string;
    priceId: string;
    workspaceId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<string> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: params.customerId,
      line_items: [{ price: params.priceId, quantity: 1 }],
      client_reference_id: params.workspaceId,
      metadata: { workspaceId: params.workspaceId },
      // Lets the webhook map the subscription back to the workspace.
      subscription_data: { metadata: { workspaceId: params.workspaceId } },
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
    });
    if (!session.url) throw new Error('Stripe returned no Checkout URL');
    return session.url;
  }

  async createPortalSession(params: {
    customerId: string;
    returnUrl: string;
  }): Promise<string> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: params.customerId,
      return_url: params.returnUrl,
    });
    return session.url;
  }

  async getSubscription(id: string): Promise<ProviderSubscription | null> {
    try {
      return toProviderSubscription(
        await this.stripe.subscriptions.retrieve(id),
      );
    } catch (err) {
      if ((err as { code?: unknown }).code === 'resource_missing') return null;
      throw err;
    }
  }

  async listLiveSubscriptions(
    customerId: string,
  ): Promise<ProviderSubscription[]> {
    // One request per live status: listing 'all' could page live ones out
    // behind a long history of canceled subscriptions.
    const pages = await Promise.all(
      [...LIVE_STATUSES].map((status) =>
        this.stripe.subscriptions.list({
          customer: customerId,
          status: status as Stripe.SubscriptionListParams.Status,
          limit: 100,
        }),
      ),
    );
    return pages.flatMap((page) => page.data.map(toProviderSubscription));
  }

  async expireOpenCheckoutSessions(customerId: string): Promise<void> {
    const open = await this.stripe.checkout.sessions.list({
      customer: customerId,
      status: 'open',
      limit: 100,
    });
    await Promise.all(
      open.data.map((session) =>
        this.stripe.checkout.sessions.expire(session.id),
      ),
    );
  }

  async listInvoices(customerId: string, limit: number): Promise<Invoice[]> {
    const page = await this.stripe.invoices.list({
      customer: customerId,
      limit,
    });
    // Drafts aren't final and have no hosted page; don't show them.
    return page.data
      .filter((invoice) => invoice.status !== 'draft')
      .map(toInvoice);
  }

  parseWebhook(rawBody: Buffer, signature: string): ProviderEvent {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.config.stripe.webhookSecret,
      );
    } catch {
      throw new InvalidWebhookSignatureError();
    }
    return {
      id: event.id,
      type: event.type,
      subscriptionId: HANDLED_EVENT_TYPES.has(event.type)
        ? subscriptionIdOf(event)
        : null,
      livemode: event.livemode === true,
    };
  }
}

/** The subscription an event refers to, per event type. */
export function subscriptionIdOf(event: Stripe.Event): string | null {
  const object = event.data.object as unknown as Record<string, unknown>;
  switch (event.type) {
    case 'checkout.session.completed':
      return idOf(object['subscription']);
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return idOf(object['id']);
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const parent = object['parent'] as
        | { subscription_details?: { subscription?: unknown } | null }
        | null
        | undefined;
      return idOf(parent?.subscription_details?.subscription);
    }
    default:
      return null;
  }
}

export function toProviderSubscription(
  sub: Stripe.Subscription,
): ProviderSubscription {
  const item = sub.items.data[0];
  const price = item?.price;
  const status = (PLAN_STATUSES as readonly string[]).includes(sub.status)
    ? (sub.status as PlanStatus)
    : 'incomplete';
  return {
    id: sub.id,
    customerId: idOf(sub.customer) ?? '',
    status,
    priceId: price?.id ?? null,
    workspaceId: sub.metadata?.['workspaceId'] || null,
    // Since API 2025-03-31 the period lives on the subscription item.
    currentPeriodEnd: item?.current_period_end
      ? new Date(item.current_period_end * 1000)
      : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    amount:
      price?.unit_amount != null
        ? price.unit_amount * (item.quantity ?? 1)
        : null,
    currency: price?.currency ?? null,
    interval: toInterval(price?.recurring?.interval),
  };
}

const INTERVALS = ['day', 'week', 'month', 'year'] as const;

function toInterval(value: unknown): ProviderSubscription['interval'] {
  return (INTERVALS as readonly unknown[]).includes(value)
    ? (value as ProviderSubscription['interval'])
    : null;
}

function toInvoice(invoice: Stripe.Invoice): Invoice {
  return {
    id: invoice.id ?? '',
    number: invoice.number ?? null,
    status: invoice.status ?? null,
    amountDue: invoice.amount_due,
    amountPaid: invoice.amount_paid,
    currency: invoice.currency,
    createdAt: new Date(invoice.created * 1000).toISOString(),
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    pdfUrl: invoice.invoice_pdf ?? null,
  };
}

/** Stripe fields are either an id or an expanded object with an id. */
function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}
