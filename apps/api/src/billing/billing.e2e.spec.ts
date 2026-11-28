import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import Stripe from 'stripe';
import { configureApp } from '../app/configure-app';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { AppConfigService } from '../config/app-config.service';
import { IdentityProvider } from '../firebase/identity.provider';
import { WorkspacesRepository } from '../workspaces/workspaces.repository';
import { BillingModule } from './billing.module';
import { BillingRepository } from './billing.repository';
import { stripeEvent, stripeSubscription } from './stripe-fixtures';
import { STRIPE_CLIENT } from './stripe.client';

const WEBHOOK_SECRET = 'whsec_' + 'e2e_dummy';
// A real Stripe client: signatures are computed and verified offline. Only
// the API calls are stubbed, so nothing reaches the network.
const stripe = new Stripe('sk_test_' + 'dummy');

@Global()
@Module({
  providers: [
    {
      provide: IdentityProvider,
      useValue: {
        verifyIdToken: async (token: string) => ({
          uid: token,
          email: `${token}@example.com`,
          emailVerified: true,
          issuedAt: new Date(),
        }),
      },
    },
    {
      provide: AppConfigService,
      useValue: {
        appUrl: 'https://app.example.com',
        stripe: {
          webhookSecret: WEBHOOK_SECRET,
          prices: { pro: 'price_pro_dummy', team: 'price_team_dummy' },
        },
      },
    },
  ],
  exports: [IdentityProvider, AppConfigService],
})
class FakeGlobalsModule {}

describe('billing api', () => {
  let app: INestApplication;
  let baseUrl: string;
  const repo = {
    getWorkspaceBilling: vi.fn(),
    saveCustomerId: vi.fn(),
    findWorkspaceIdByCustomer: vi.fn(),
    isEventProcessed: vi.fn(),
    markEventProcessed: vi.fn(),
    applySubscription: vi.fn(),
    endSubscription: vi.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeGlobalsModule, BillingModule],
      providers: [{ provide: APP_GUARD, useClass: FirebaseAuthGuard }],
    })
      .overrideProvider(STRIPE_CLIENT)
      .useValue(stripe)
      .overrideProvider(BillingRepository)
      .useValue(repo)
      .overrideProvider(WorkspacesRepository)
      .useValue({
        isMember: vi.fn().mockResolvedValue(false),
        getMemberRole: vi.fn().mockResolvedValue(null),
      })
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    configureApp(app, { trustProxyHops: 1 });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    repo.getWorkspaceBilling.mockResolvedValue({
      exists: false,
      type: null,
      ownerUid: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      plan: null,
      deletionLocked: false,
    });
    repo.saveCustomerId.mockImplementation(
      async (_ws: string, id: string) => id,
    );
    repo.isEventProcessed.mockResolvedValue(false);
    repo.applySubscription.mockResolvedValue('applied');
  });

  const postWebhook = (body: string, signature?: string) =>
    fetch(`${baseUrl}/api/billing/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature && { 'Stripe-Signature': signature }),
      },
      body,
    });

  const sign = (body: string, secret = WEBHOOK_SECRET) =>
    stripe.webhooks.generateTestHeaderString({ payload: body, secret });

  describe('POST /api/billing/webhook', () => {
    it('verifies the signature on the raw body and syncs the subscription', async () => {
      const retrieve = vi
        .spyOn(stripe.subscriptions, 'retrieve')
        .mockResolvedValue(stripeSubscription() as never);
      // Pretty-printed on purpose: re-serializing the parsed JSON would change
      // the bytes and break the signature, so this proves the raw body is used.
      const body = JSON.stringify(
        stripeEvent(
          'customer.subscription.updated',
          { id: 'sub_123' },
          'evt_42',
        ),
        null,
        2,
      );

      const res = await postWebhook(body, sign(body));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true });
      expect(retrieve).toHaveBeenCalledWith('sub_123');
      expect(repo.applySubscription).toHaveBeenCalledWith(
        'alice',
        expect.objectContaining({
          id: 'sub_123',
          status: 'active',
          priceId: 'price_pro_dummy',
        }),
        'pro',
      );
      expect(repo.markEventProcessed).toHaveBeenCalledWith(
        'evt_42',
        'customer.subscription.updated',
      );
    });

    it('handles invoice and checkout events through their subscription', async () => {
      vi.spyOn(stripe.subscriptions, 'retrieve').mockResolvedValue(
        stripeSubscription({ status: 'past_due' }) as never,
      );
      for (const event of [
        stripeEvent('invoice.payment_failed', {
          parent: { subscription_details: { subscription: 'sub_123' } },
        }),
        stripeEvent(
          'checkout.session.completed',
          { subscription: 'sub_123' },
          'evt_2',
        ),
      ]) {
        const body = JSON.stringify(event);
        expect((await postWebhook(body, sign(body))).status).toBe(200);
      }
      expect(repo.applySubscription).toHaveBeenCalledTimes(2);
    });

    it('rejects unsigned, wrongly signed and tampered events with 400', async () => {
      const body = JSON.stringify(
        stripeEvent('customer.subscription.updated', { id: 'sub_1' }),
      );
      expect((await postWebhook(body)).status).toBe(400);
      expect(
        (await postWebhook(body, sign(body, 'whsec_' + 'wrong'))).status,
      ).toBe(400);
      expect(
        (await postWebhook(body.replace('sub_1', 'sub_2'), sign(body))).status,
      ).toBe(400);
      expect(repo.applySubscription).not.toHaveBeenCalled();
    });

    it('acknowledges unhandled event types', async () => {
      const body = JSON.stringify(
        stripeEvent('customer.created', { id: 'cus_1' }),
      );
      expect((await postWebhook(body, sign(body))).status).toBe(200);
      expect(repo.isEventProcessed).not.toHaveBeenCalled();
    });

    it('answers 500 (so Stripe retries) when the sync fails', async () => {
      vi.spyOn(stripe.subscriptions, 'retrieve').mockRejectedValue(
        new Error('network down'),
      );
      const body = JSON.stringify(
        stripeEvent('customer.subscription.updated', { id: 'sub_1' }),
      );

      const res = await postWebhook(body, sign(body));

      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain('network down');
      expect(repo.markEventProcessed).not.toHaveBeenCalled();
    });
  });

  describe('checkout, portal, invoices', () => {
    const post = (path: string, body: unknown, as?: string) =>
      fetch(`${baseUrl}/api/billing/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(as && { Authorization: `Bearer ${as}` }),
        },
        body: JSON.stringify(body),
      });

    it('returns a Checkout URL for the signed-in owner', async () => {
      vi.spyOn(stripe.customers, 'create').mockResolvedValue({
        id: 'cus_new',
      } as never);
      const create = vi
        .spyOn(stripe.checkout.sessions, 'create')
        .mockResolvedValue({ url: 'https://checkout.stripe.test/s' } as never);

      const res = await post(
        'checkout',
        { workspaceId: 'alice', plan: 'pro' },
        'alice',
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        url: 'https://checkout.stripe.test/s',
      });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'subscription',
          customer: 'cus_new',
          line_items: [{ price: 'price_pro_dummy', quantity: 1 }],
          subscription_data: { metadata: { workspaceId: 'alice' } },
        }),
      );
    });

    it('refuses checkout while Stripe already has a live subscription', async () => {
      repo.getWorkspaceBilling.mockResolvedValue({
        exists: true,
        type: 'personal',
        ownerUid: 'alice',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: null,
        plan: null, // webhook not synced yet
        deletionLocked: false,
      });
      vi.spyOn(stripe.subscriptions, 'list').mockResolvedValue({
        data: [stripeSubscription()],
      } as never);
      const create = vi.spyOn(stripe.checkout.sessions, 'create');

      const res = await post(
        'checkout',
        { workspaceId: 'alice', plan: 'pro' },
        'alice',
      );

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'already_subscribed' });
      expect(create).not.toHaveBeenCalled();
    });

    it('requires auth and a valid body; the client cannot pick a price', async () => {
      expect(
        (await post('checkout', { workspaceId: 'alice', plan: 'pro' })).status,
      ).toBe(401);
      expect(
        (
          await post(
            'checkout',
            { workspaceId: 'alice', plan: 'pro', priceId: 'price_cheap' },
            'alice',
          )
        ).status,
      ).toBe(400);
      expect(
        (await post('checkout', { workspaceId: 'bob', plan: 'pro' }, 'alice'))
          .status,
      ).toBe(404);
    });

    it('409s the portal before a first purchase; invoices are empty', async () => {
      const portal = await post('portal', { workspaceId: 'alice' }, 'alice');
      expect(portal.status).toBe(409);

      const invoices = await fetch(
        `${baseUrl}/api/billing/invoices?workspaceId=alice`,
        {
          headers: { Authorization: 'Bearer alice' },
        },
      );
      expect(await invoices.json()).toEqual({ items: [] });
    });

    it('reports the subscription to the owner, validating the query', async () => {
      const get = (query: string) =>
        fetch(`${baseUrl}/api/billing/subscription${query}`, {
          headers: { Authorization: 'Bearer alice' },
        });
      const res = await get('?workspaceId=alice');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        workspaceId: 'alice',
        plan: 'free',
        subscription: null,
        canOpenPortal: false,
      });
      expect((await get('')).status).toBe(400);
      expect((await get('?workspaceId=bob')).status).toBe(404);
    });

    it('validates the invoices query and hides other workspaces', async () => {
      const get = (query: string) =>
        fetch(`${baseUrl}/api/billing/invoices${query}`, {
          headers: { Authorization: 'Bearer alice' },
        });
      expect((await get('')).status).toBe(400);
      expect((await get('?workspaceId=alice&extra=1')).status).toBe(400);
      expect((await get('?workspaceId=bob')).status).toBe(404);
    });
  });
});
