import { describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import type { AppConfigService } from '../config/app-config.service';
import { InvalidWebhookSignatureError } from './billing.provider';
import { stripeEvent, stripeSubscription } from './stripe-fixtures';
import {
  StripeBillingProvider,
  subscriptionIdOf,
  toProviderSubscription,
} from './stripe-billing.provider';

// Offline: constructing the client and signing/verifying webhooks make no requests.
const SECRET = 'whsec_' + 'test_dummy';
const stripe = new Stripe('sk_test_' + 'dummy');
const config = { stripe: { webhookSecret: SECRET } } as AppConfigService;
const provider = new StripeBillingProvider(stripe, config);

function signed(payload: object, secret = SECRET) {
  const body = JSON.stringify(payload);
  const header = stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret,
  });
  return { body: Buffer.from(body), header };
}

describe('subscriptionIdOf', () => {
  it.each([
    ['checkout.session.completed', { subscription: 'sub_a' }, 'sub_a'],
    ['checkout.session.completed', { subscription: { id: 'sub_b' } }, 'sub_b'],
    ['customer.subscription.updated', { id: 'sub_c' }, 'sub_c'],
    ['customer.subscription.deleted', { id: 'sub_d' }, 'sub_d'],
    [
      'invoice.paid',
      { parent: { subscription_details: { subscription: 'sub_e' } } },
      'sub_e',
    ],
    ['invoice.payment_failed', { parent: null }, null],
    ['checkout.session.completed', { subscription: null }, null],
  ])('%s %j → %s', (type, object, expected) => {
    expect(
      subscriptionIdOf(stripeEvent(type, object) as unknown as Stripe.Event),
    ).toBe(expected);
  });
});

describe('toProviderSubscription', () => {
  it('maps the fields the sync needs, with the period from the item', () => {
    expect(toProviderSubscription(stripeSubscription({ quantity: 2 }))).toEqual(
      {
        id: 'sub_123',
        customerId: 'cus_123',
        status: 'active',
        priceId: 'price_pro_dummy',
        workspaceId: 'alice',
        currentPeriodEnd: new Date(1_790_000_000 * 1000),
        cancelAtPeriodEnd: false,
        amount: 1800,
        currency: 'usd',
        interval: 'month',
      },
    );
  });

  it('tolerates missing metadata and amounts', () => {
    const sub = toProviderSubscription(
      stripeSubscription({ workspaceId: null, unitAmount: null }),
    );
    expect(sub).toMatchObject({ workspaceId: null, amount: null });
  });
});

describe('parseWebhook', () => {
  it('verifies a correctly signed event and extracts the subscription', () => {
    const { body, header } = signed(
      stripeEvent('customer.subscription.updated', { id: 'sub_x' }, 'evt_x'),
    );
    expect(provider.parseWebhook(body, header)).toEqual({
      id: 'evt_x',
      type: 'customer.subscription.updated',
      subscriptionId: 'sub_x',
      livemode: false,
    });
  });

  it('ignores the subscription of unhandled event types', () => {
    const { body, header } = signed(
      stripeEvent('customer.created', { id: 'cus_1' }),
    );
    expect(provider.parseWebhook(body, header).subscriptionId).toBeNull();
  });

  it('rejects a wrong secret, a tampered body and a garbage header', () => {
    const event = stripeEvent('customer.subscription.updated', { id: 'sub_x' });
    const wrong = signed(event, 'whsec_' + 'other');
    expect(() => provider.parseWebhook(wrong.body, wrong.header)).toThrow(
      InvalidWebhookSignatureError,
    );

    const ok = signed(event);
    const tampered = Buffer.from(ok.body.toString().replace('sub_x', 'sub_y'));
    expect(() => provider.parseWebhook(tampered, ok.header)).toThrow(
      InvalidWebhookSignatureError,
    );
    expect(() => provider.parseWebhook(ok.body, 'nope')).toThrow(
      InvalidWebhookSignatureError,
    );
  });
});

describe('getSubscription', () => {
  it('returns null when Stripe says the subscription is missing', async () => {
    const client = {
      subscriptions: {
        retrieve: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('x'), { code: 'resource_missing' }),
          ),
      },
    } as unknown as Stripe;
    expect(
      await new StripeBillingProvider(client, config).getSubscription('sub_x'),
    ).toBeNull();
  });
});

describe('cancelAllSubscriptions', () => {
  const sub = (id: string, status: string) => ({ id, status });

  it('pages through every subscription and cancels all that can still bill', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          sub('sub_active', 'active'),
          sub('sub_incomplete', 'incomplete'),
          sub('sub_done', 'canceled'),
        ],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [
          sub('sub_unpaid', 'unpaid'),
          sub('sub_paused', 'paused'),
          sub('sub_trial', 'trialing'),
          sub('sub_late', 'past_due'),
          sub('sub_expired', 'incomplete_expired'),
        ],
        has_more: false,
      });
    const cancel = vi
      .fn()
      .mockResolvedValueOnce({})
      // Already gone by the time we get to it: fine.
      .mockRejectedValueOnce(
        Object.assign(new Error('x'), { code: 'resource_missing' }),
      )
      .mockResolvedValue({});
    const client = { subscriptions: { list, cancel } } as unknown as Stripe;

    const canceled = await new StripeBillingProvider(
      client,
      config,
    ).cancelAllSubscriptions('cus_1');

    expect(list).toHaveBeenNthCalledWith(1, {
      customer: 'cus_1',
      status: 'all',
      limit: 100,
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      customer: 'cus_1',
      status: 'all',
      limit: 100,
      starting_after: 'sub_done',
    });
    const expected = [
      'sub_active',
      'sub_incomplete',
      'sub_unpaid',
      'sub_paused',
      'sub_trial',
      'sub_late',
    ];
    expect(canceled).toEqual(expected);
    expect(cancel.mock.calls.map(([id]) => id)).toEqual(expected);
  });

  it('cancels nothing for a customer without open subscriptions', async () => {
    const cancel = vi.fn();
    const client = {
      subscriptions: {
        list: vi.fn().mockResolvedValue({ data: [], has_more: false }),
        cancel,
      },
    } as unknown as Stripe;
    expect(
      await new StripeBillingProvider(client, config).cancelAllSubscriptions(
        'cus_1',
      ),
    ).toEqual([]);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('fails on any other Stripe error', async () => {
    const client = {
      subscriptions: {
        list: vi
          .fn()
          .mockResolvedValue({ data: [sub('s', 'active')], has_more: false }),
        cancel: vi.fn().mockRejectedValue(new Error('down')),
      },
    } as unknown as Stripe;
    await expect(
      new StripeBillingProvider(client, config).cancelAllSubscriptions('c'),
    ).rejects.toThrow('down');
  });
});

describe('live mode, live subscriptions and invoices', () => {
  it('flags live-mode events', () => {
    const { body, header } = signed({
      ...stripeEvent('customer.subscription.updated', { id: 'sub_x' }),
      livemode: true,
    });
    expect(provider.parseWebhook(body, header).livemode).toBe(true);
  });

  it('lists live subscriptions with one request per live status', async () => {
    const byStatus: Record<string, Stripe.Subscription[]> = {
      active: [stripeSubscription({ id: 'sub_a', status: 'active' })],
      trialing: [],
      past_due: [stripeSubscription({ id: 'sub_c', status: 'past_due' })],
    };
    const list = vi.fn(async ({ status }: { status: string }) => ({
      data: byStatus[status] ?? [],
    }));
    const client = { subscriptions: { list } } as unknown as Stripe;

    const live = await new StripeBillingProvider(
      client,
      config,
    ).listLiveSubscriptions('cus_1');

    expect(live.map((s) => s.id).sort()).toEqual(['sub_a', 'sub_c']);
    expect(list.mock.calls.map(([params]) => params.status).sort()).toEqual([
      'active',
      'past_due',
      'trialing',
    ]);
  });

  it('expires every open Checkout Session of the customer', async () => {
    const expire = vi.fn().mockResolvedValue({});
    const client = {
      checkout: {
        sessions: {
          list: vi
            .fn()
            .mockResolvedValue({ data: [{ id: 'cs_1' }, { id: 'cs_2' }] }),
          expire,
        },
      },
    } as unknown as Stripe;

    await new StripeBillingProvider(client, config).expireOpenCheckoutSessions(
      'cus_1',
    );

    expect(client.checkout.sessions.list).toHaveBeenCalledWith({
      customer: 'cus_1',
      status: 'open',
      limit: 100,
    });
    expect(expire.mock.calls.map(([id]) => id)).toEqual(['cs_1', 'cs_2']);
  });

  it('leaves draft invoices out', async () => {
    const invoice = (id: string, status: string) => ({
      id,
      status,
      number: null,
      amount_due: 900,
      amount_paid: 0,
      currency: 'usd',
      created: 1_790_000_000,
      hosted_invoice_url: null,
      invoice_pdf: null,
    });
    const client = {
      invoices: {
        list: vi.fn().mockResolvedValue({
          data: [
            invoice('in_1', 'paid'),
            invoice('in_2', 'draft'),
            invoice('in_3', 'open'),
          ],
        }),
      },
    } as unknown as Stripe;

    const items = await new StripeBillingProvider(client, config).listInvoices(
      'cus_1',
      10,
    );

    expect(items.map((i) => i.id)).toEqual(['in_1', 'in_3']);
    expect(items[0]).toMatchObject({
      amountDue: 900,
      createdAt: '2026-09-21T14:13:20.000Z',
    });
  });
});
