import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import type { AppConfigService } from '../config/app-config.service';
import type { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import {
  type BillingProvider,
  InvalidWebhookSignatureError,
  type ProviderSubscription,
} from './billing.provider';
import type { BillingRepository, WorkspaceBilling } from './billing.repository';
import { BillingService } from './billing.service';

const alice: AuthUser = {
  uid: 'alice',
  email: 'alice@example.com',
  emailVerified: true,
  role: 'user',
  tokenIssuedAt: new Date(0),
};

const noBilling: WorkspaceBilling = {
  exists: false,
  type: null,
  ownerUid: null,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  plan: null,
};

const sub = (
  overrides: Partial<ProviderSubscription> = {},
): ProviderSubscription => ({
  id: 'sub_1',
  customerId: 'cus_1',
  status: 'active',
  priceId: 'price_pro',
  workspaceId: 'alice',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  amount: 900,
  currency: 'usd',
  interval: 'month',
  ...overrides,
});

describe('BillingService', () => {
  const provider = {
    createCustomer: vi.fn(),
    createCheckoutSession: vi.fn(),
    createPortalSession: vi.fn(),
    getSubscription: vi.fn(),
    listLiveSubscriptions: vi.fn(),
    expireOpenCheckoutSessions: vi.fn(),
    listInvoices: vi.fn(),
    parseWebhook: vi.fn(),
  };
  const repo = {
    getWorkspaceBilling: vi.fn(),
    saveCustomerId: vi.fn(),
    findWorkspaceIdByCustomer: vi.fn(),
    isEventProcessed: vi.fn(),
    markEventProcessed: vi.fn(),
    applySubscription: vi.fn(),
    endSubscription: vi.fn(),
  };
  /** Role per team workspace; the caller owns their personal workspace. */
  let teamRoles: Record<string, 'owner' | 'admin' | 'member'> = {};
  const access = { getRole: vi.fn() };
  const config = {
    appUrl: 'https://app.example.com',
    stripe: { prices: { pro: 'price_pro', team: 'price_team' } },
  } as AppConfigService;
  let service: BillingService;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    provider.listLiveSubscriptions.mockResolvedValue([]);
    repo.getWorkspaceBilling.mockResolvedValue(noBilling);
    teamRoles = {};
    access.getRole.mockImplementation(async (user: AuthUser, ws: string) =>
      ws === user.uid ? 'owner' : (teamRoles[ws] ?? null),
    );
    repo.saveCustomerId.mockImplementation(async (_ws, id) => id);
    provider.createCustomer.mockResolvedValue('cus_new');
    provider.createCheckoutSession.mockResolvedValue(
      'https://checkout.stripe.test/s',
    );
    service = new BillingService(
      provider as unknown as BillingProvider,
      repo as unknown as BillingRepository,
      access as unknown as WorkspaceAccessService,
      config,
    );
  });

  describe('createCheckout', () => {
    it('creates a customer once and a Checkout Session for Pro', async () => {
      const res = await service.createCheckout(alice, 'alice', 'pro');

      expect(res).toEqual({ url: 'https://checkout.stripe.test/s' });
      expect(provider.createCustomer).toHaveBeenCalledWith({
        workspaceId: 'alice',
        email: 'alice@example.com',
      });
      expect(repo.saveCustomerId).toHaveBeenCalledWith(
        'alice',
        'cus_new',
        'alice',
      );
      expect(provider.createCheckoutSession).toHaveBeenCalledWith({
        customerId: 'cus_new',
        priceId: 'price_pro',
        workspaceId: 'alice',
        successUrl: 'https://app.example.com/billing?checkout=success',
        cancelUrl: 'https://app.example.com/billing?checkout=canceled',
      });
    });

    it('reuses the stored customer (or the one a concurrent checkout saved)', async () => {
      repo.getWorkspaceBilling.mockResolvedValue({
        ...noBilling,
        stripeCustomerId: 'cus_old',
      });
      await service.createCheckout(alice, 'alice', 'pro');
      expect(provider.createCustomer).not.toHaveBeenCalled();

      repo.getWorkspaceBilling.mockResolvedValue(noBilling);
      repo.saveCustomerId.mockResolvedValue('cus_winner');
      await service.createCheckout(alice, 'alice', 'pro');
      expect(provider.createCheckoutSession).toHaveBeenLastCalledWith(
        expect.objectContaining({ customerId: 'cus_winner' }),
      );
    });

    it('sells Pro only to personal and Team only to team workspaces', async () => {
      teamRoles = { 'team-1': 'owner' };
      await expect(
        service.createCheckout(alice, 'alice', 'team'),
      ).rejects.toMatchObject({
        response: { code: 'plan_not_available' },
      });
      repo.getWorkspaceBilling.mockResolvedValue({
        ...noBilling,
        exists: true,
        type: 'team',
        ownerUid: 'alice',
      });
      await expect(
        service.createCheckout(alice, 'team-1', 'pro'),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.createCheckout(alice, 'team-1', 'team'),
      ).resolves.toBeDefined();
    });

    it('refuses a second subscription (409 already_subscribed)', async () => {
      repo.getWorkspaceBilling.mockResolvedValue({
        ...noBilling,
        plan: {
          id: 'pro',
          status: 'past_due',
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
        },
      });
      await expect(
        service.createCheckout(alice, 'alice', 'pro'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('asks Stripe too: a live subscription not yet synced blocks a second checkout', async () => {
      repo.getWorkspaceBilling.mockResolvedValue({
        ...noBilling,
        stripeCustomerId: 'cus_1',
      });
      provider.listLiveSubscriptions.mockResolvedValue([sub()]);

      await expect(
        service.createCheckout(alice, 'alice', 'pro'),
      ).rejects.toMatchObject({
        response: { code: 'already_subscribed' },
      });
      expect(provider.listLiveSubscriptions).toHaveBeenCalledWith('cus_1');
      expect(provider.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('expires older open Checkouts so two tabs cannot both be paid', async () => {
      repo.getWorkspaceBilling.mockResolvedValue({
        ...noBilling,
        stripeCustomerId: 'cus_1',
      });

      await service.createCheckout(alice, 'alice', 'pro');

      expect(provider.expireOpenCheckoutSessions).toHaveBeenCalledWith('cus_1');
      const expireOrder =
        provider.expireOpenCheckoutSessions.mock.invocationCallOrder[0];
      const createOrder =
        provider.createCheckoutSession.mock.invocationCallOrder[0];
      expect(expireOrder).toBeLessThan(createOrder);
    });

    it('lets only the owner of a team buy (403), and hides others (404)', async () => {
      teamRoles = { 'team-1': 'admin' };
      await expect(
        service.createCheckout(alice, 'team-1', 'team'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.createCheckout(alice, 'team-2', 'team'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('turns provider failures into a 503 without details', async () => {
      provider.createCheckoutSession.mockRejectedValue(
        new Error('StripeAuthenticationError: sk_...'),
      );
      const err = await service
        .createCheckout(alice, 'alice', 'pro')
        .catch((e) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(JSON.stringify(err.getResponse())).not.toContain('sk_');
    });
  });

  describe('portal and invoices', () => {
    it('opens the portal for an existing customer', async () => {
      repo.getWorkspaceBilling.mockResolvedValue({
        ...noBilling,
        stripeCustomerId: 'cus_1',
      });
      provider.createPortalSession.mockResolvedValue(
        'https://billing.stripe.test/p',
      );

      expect(await service.createPortal(alice, 'alice')).toEqual({
        url: 'https://billing.stripe.test/p',
      });
      expect(provider.createPortalSession).toHaveBeenCalledWith({
        customerId: 'cus_1',
        returnUrl: 'https://app.example.com/billing',
      });
    });

    it('has no portal before a first purchase (409) and no invoices', async () => {
      await expect(service.createPortal(alice, 'alice')).rejects.toMatchObject({
        response: { code: 'no_billing_account' },
      });
      expect(await service.listInvoices(alice, 'alice')).toEqual({ items: [] });
      expect(provider.listInvoices).not.toHaveBeenCalled();
    });

    it('lists invoices of the customer', async () => {
      repo.getWorkspaceBilling.mockResolvedValue({
        ...noBilling,
        stripeCustomerId: 'cus_1',
      });
      provider.listInvoices.mockResolvedValue([{ id: 'in_1' }]);
      expect(await service.listInvoices(alice, 'alice')).toEqual({
        items: [{ id: 'in_1' }],
      });
      expect(provider.listInvoices).toHaveBeenCalledWith('cus_1', 24);
    });
  });

  describe('handleWebhook', () => {
    const raw = Buffer.from('{}');

    beforeEach(() => {
      provider.parseWebhook.mockReturnValue({
        id: 'evt_1',
        type: 'customer.subscription.updated',
        subscriptionId: 'sub_1',
      });
      repo.isEventProcessed.mockResolvedValue(false);
      provider.getSubscription.mockResolvedValue(sub());
      repo.applySubscription.mockResolvedValue('applied');
    });

    it('re-fetches the subscription, applies it and marks the event', async () => {
      await service.handleWebhook(raw, 'sig');

      expect(provider.getSubscription).toHaveBeenCalledWith('sub_1');
      expect(repo.applySubscription).toHaveBeenCalledWith(
        'alice',
        sub(),
        'pro',
      );
      expect(repo.markEventProcessed).toHaveBeenCalledWith(
        'evt_1',
        'customer.subscription.updated',
      );
    });

    it('rejects a missing or invalid signature with 400', async () => {
      await expect(
        service.handleWebhook(raw, undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.handleWebhook(undefined, 'sig'),
      ).rejects.toBeInstanceOf(BadRequestException);
      provider.parseWebhook.mockImplementation(() => {
        throw new InvalidWebhookSignatureError();
      });
      await expect(service.handleWebhook(raw, 'sig')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repo.applySubscription).not.toHaveBeenCalled();
    });

    it('acknowledges unhandled events without touching anything', async () => {
      provider.parseWebhook.mockReturnValue({
        id: 'evt_2',
        type: 'customer.created',
        subscriptionId: null,
      });
      await service.handleWebhook(raw, 'sig');
      expect(repo.isEventProcessed).not.toHaveBeenCalled();
      expect(provider.getSubscription).not.toHaveBeenCalled();
    });

    it('skips an event it already processed', async () => {
      repo.isEventProcessed.mockResolvedValue(true);
      await service.handleWebhook(raw, 'sig');
      expect(provider.getSubscription).not.toHaveBeenCalled();
      expect(repo.markEventProcessed).not.toHaveBeenCalled();
    });

    it('maps the Team price and finds the workspace by customer without metadata', async () => {
      provider.getSubscription.mockResolvedValue(
        sub({ priceId: 'price_team', workspaceId: null }),
      );
      repo.findWorkspaceIdByCustomer.mockResolvedValue('team-1');

      await service.handleWebhook(raw, 'sig');

      expect(repo.findWorkspaceIdByCustomer).toHaveBeenCalledWith('cus_1');
      expect(repo.applySubscription).toHaveBeenCalledWith(
        'team-1',
        expect.anything(),
        'team',
      );
    });

    it.each([
      [
        'unknown price',
        () =>
          provider.getSubscription.mockResolvedValue(
            sub({ priceId: 'price_other' }),
          ),
      ],
      [
        'deleted subscription',
        () => provider.getSubscription.mockResolvedValue(null),
      ],
      [
        'unknown workspace',
        () => {
          provider.getSubscription.mockResolvedValue(
            sub({ workspaceId: null }),
          );
          repo.findWorkspaceIdByCustomer.mockResolvedValue(null);
        },
      ],
    ])(
      'acknowledges (and marks) an event with an %s',
      async (_name, arrange) => {
        arrange();
        await service.handleWebhook(raw, 'sig');
        expect(repo.applySubscription).not.toHaveBeenCalled();
        expect(repo.markEventProcessed).toHaveBeenCalled();
      },
    );

    it('falls back to another live subscription when this one ended', async () => {
      provider.getSubscription.mockResolvedValue(
        sub({ id: 'sub_1', status: 'canceled' }),
      );
      provider.listLiveSubscriptions.mockResolvedValue([
        sub({ id: 'sub_1', status: 'active' }),
        sub({ id: 'sub_2', status: 'active' }),
      ]);

      await service.handleWebhook(raw, 'sig');

      expect(repo.applySubscription).toHaveBeenCalledWith(
        'alice',
        expect.objectContaining({ id: 'sub_2', status: 'active' }),
        'pro',
      );
    });

    it('records the end when nothing else is live', async () => {
      provider.getSubscription.mockResolvedValue(sub({ status: 'canceled' }));
      repo.endSubscription.mockResolvedValue('applied');

      await service.handleWebhook(raw, 'sig');

      expect(repo.endSubscription).toHaveBeenCalledWith(
        'alice',
        expect.objectContaining({ id: 'sub_1', status: 'canceled' }),
      );
      expect(repo.applySubscription).not.toHaveBeenCalled();
    });

    it('records the end even when the ended price is unknown (fails closed)', async () => {
      provider.getSubscription.mockResolvedValue(
        sub({ status: 'canceled', priceId: 'price_switched_in_dashboard' }),
      );

      await service.handleWebhook(raw, 'sig');

      expect(repo.endSubscription).toHaveBeenCalled();
    });

    it("records the end when the other live subscription doesn't fit", async () => {
      provider.getSubscription.mockResolvedValue(sub({ status: 'canceled' }));
      provider.listLiveSubscriptions.mockResolvedValue([
        sub({ id: 'sub_odd', priceId: 'price_unknown' }),
        sub({ id: 'sub_team', priceId: 'price_team' }),
      ]);
      repo.applySubscription.mockResolvedValue('ignored_plan_mismatch');

      await service.handleWebhook(raw, 'sig');

      expect(repo.applySubscription).toHaveBeenCalledTimes(1); // only sub_team has a known price
      expect(repo.endSubscription).toHaveBeenCalledWith(
        'alice',
        expect.objectContaining({ id: 'sub_1' }),
      );
    });

    it('ignores live-mode events', async () => {
      provider.parseWebhook.mockReturnValue({
        id: 'evt_live',
        type: 'customer.subscription.updated',
        subscriptionId: 'sub_1',
        livemode: true,
      });
      await service.handleWebhook(raw, 'sig');
      expect(provider.getSubscription).not.toHaveBeenCalled();
      expect(Logger.prototype.warn).toHaveBeenCalled();
    });

    it('warns about events that were not applied', async () => {
      provider.getSubscription.mockResolvedValue(
        sub({ priceId: 'price_typo' }),
      );
      await service.handleWebhook(raw, 'sig');
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining('unknown_price'),
      );
    });

    it('does not mark the event when applying fails, so Stripe retries', async () => {
      repo.applySubscription.mockRejectedValue(new Error('firestore down'));
      await expect(service.handleWebhook(raw, 'sig')).rejects.toThrow(
        'firestore down',
      );
      expect(repo.markEventProcessed).not.toHaveBeenCalled();
    });
  });
});
