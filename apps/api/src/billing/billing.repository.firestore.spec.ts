/**
 * FirestoreBillingRepository against the Firestore emulator. Skipped unless
 * FIRESTORE_EMULATOR_HOST is set; run with `npx nx test-firestore api`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import {
  type Firestore,
  getFirestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { DELETION_LOCK_MS } from '../workspaces/workspace-docs';
import { effectivePlanId } from '@saas-starter/shared';
import { FirestoreLinksRepository } from '../links/links.repository';
import { FirestoreWorkspacesRepository } from '../workspaces/workspaces.repository';
import type { ProviderSubscription } from './billing.provider';
import { FirestoreBillingRepository } from './billing.repository';

const host = process.env['FIRESTORE_EMULATOR_HOST'];
const PROJECT = 'demo-links-test';

const sub = (
  overrides: Partial<ProviderSubscription> = {},
): ProviderSubscription => ({
  id: 'sub_1',
  customerId: 'cus_1',
  status: 'active',
  priceId: 'price_pro',
  workspaceId: 'alice',
  currentPeriodEnd: new Date('2027-01-01T00:00:00.000Z'),
  cancelAtPeriodEnd: false,
  amount: 900,
  currency: 'usd',
  interval: 'month',
  ...overrides,
});

describe.skipIf(!host)('FirestoreBillingRepository (emulator)', () => {
  let app: App;
  let db: Firestore;
  let repo: FirestoreBillingRepository;

  beforeAll(() => {
    app = initializeApp({ projectId: PROJECT }, 'billing-repo-spec');
    db = getFirestore(app);
    repo = new FirestoreBillingRepository(db);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  beforeEach(async () => {
    await fetch(
      `http://${host}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
      { method: 'DELETE' },
    );
  });

  describe('saveCustomerId', () => {
    it('creates the personal workspace with the customer, then keeps the first one', async () => {
      expect(await repo.saveCustomerId('alice', 'cus_1', 'alice')).toBe(
        'cus_1',
      );
      expect(await repo.saveCustomerId('alice', 'cus_2', 'alice')).toBe(
        'cus_1',
      );

      const billing = await repo.getWorkspaceBilling('alice');
      expect(billing).toMatchObject({
        exists: true,
        type: 'personal',
        ownerUid: 'alice',
        stripeCustomerId: 'cus_1',
        deletionLocked: false,
      });

      // An account deletion's lock, fresh then lapsed.
      const lock = (msAgo: number) =>
        db
          .doc('workspaces/alice')
          .update({ deletingAt: Timestamp.fromMillis(Date.now() - msAgo) });
      await lock(0);
      expect((await repo.getWorkspaceBilling('alice')).deletionLocked).toBe(
        true,
      );
      await lock(DELETION_LOCK_MS + 1000);
      expect((await repo.getWorkspaceBilling('alice')).deletionLocked).toBe(
        false,
      );
      expect(await repo.findWorkspaceIdByCustomer('cus_1')).toBe('alice');
      expect(await repo.findWorkspaceIdByCustomer('cus_x')).toBeNull();
    });

    it('settles concurrent checkouts on one customer', async () => {
      const ids = await Promise.all([
        repo.saveCustomerId('alice', 'cus_a', 'alice'),
        repo.saveCustomerId('alice', 'cus_b', 'alice'),
      ]);
      expect(ids[0]).toBe(ids[1]);
    }, 60_000);

    it('refuses a missing team workspace', async () => {
      await expect(
        repo.saveCustomerId('team-1', 'cus_1', null),
      ).rejects.toThrow();
    });
  });

  describe('applySubscription', () => {
    beforeEach(async () => {
      await repo.saveCustomerId('alice', 'cus_1', 'alice');
    });

    it('writes the plan and the subscriptions mirror', async () => {
      expect(await repo.applySubscription('alice', sub(), 'pro')).toBe(
        'applied',
      );

      const billing = await repo.getWorkspaceBilling('alice');
      expect(billing.plan).toEqual({
        id: 'pro',
        status: 'active',
        currentPeriodEnd: '2027-01-01T00:00:00.000Z',
        cancelAtPeriodEnd: false,
      });
      expect(billing.stripeSubscriptionId).toBe('sub_1');
      expect((await db.doc('subscriptions/sub_1').get()).data()).toMatchObject({
        workspaceId: 'alice',
        plan: 'pro',
        status: 'active',
        amount: 900,
        interval: 'month',
      });
    });

    it('drops to Free when the subscription is canceled', async () => {
      await repo.applySubscription('alice', sub(), 'pro');
      await repo.applySubscription('alice', sub({ status: 'canceled' }), 'pro');

      expect(
        effectivePlanId((await repo.getWorkspaceBilling('alice')).plan),
      ).toBe('free');
    });

    it('does not let an old, ended subscription overwrite the current one', async () => {
      await repo.applySubscription('alice', sub({ id: 'sub_new' }), 'pro');

      const result = await repo.applySubscription(
        'alice',
        sub({ id: 'sub_old', status: 'canceled' }),
        'pro',
      );

      expect(result).toBe('ignored_other_subscription');
      const billing = await repo.getWorkspaceBilling('alice');
      expect(billing.stripeSubscriptionId).toBe('sub_new');
      expect(billing.plan?.status).toBe('active');
      expect((await db.doc('subscriptions/sub_old').get()).get('status')).toBe(
        'canceled',
      );
    });

    it("ignores a subscription of another workspace's customer", async () => {
      expect(
        await repo.applySubscription(
          'alice',
          sub({ customerId: 'cus_evil' }),
          'pro',
        ),
      ).toBe('ignored_customer_mismatch');
      expect((await repo.getWorkspaceBilling('alice')).plan).toBeNull();
    });

    it('refuses a Team plan on a personal workspace (and Pro on a team)', async () => {
      expect(await repo.applySubscription('alice', sub(), 'team')).toBe(
        'ignored_plan_mismatch',
      );
      expect((await repo.getWorkspaceBilling('alice')).plan).toBeNull();
      // The mirror still records it for admin stats.
      expect((await db.doc('subscriptions/sub_1').get()).get('plan')).toBe(
        'team',
      );

      await db
        .doc('workspaces/team-1')
        .set({ type: 'team', ownerUid: 'bob', stripeCustomerId: 'cus_t' });
      expect(
        await repo.applySubscription(
          'team-1',
          sub({ id: 'sub_t', customerId: 'cus_t', workspaceId: 'team-1' }),
          'pro',
        ),
      ).toBe('ignored_plan_mismatch');
      expect(
        await repo.applySubscription(
          'team-1',
          sub({ id: 'sub_t', customerId: 'cus_t', workspaceId: 'team-1' }),
          'team',
        ),
      ).toBe('applied');
    });

    it('ends the current subscription whatever its price: Pro → Team → canceled is Free', async () => {
      await repo.applySubscription('alice', sub(), 'pro');
      // Moved to the Team price (portal/dashboard): ignored for a personal workspace…
      expect(await repo.applySubscription('alice', sub(), 'team')).toBe(
        'ignored_plan_mismatch',
      );
      // …but its cancellation still ends the plan.
      expect(
        await repo.endSubscription('alice', sub({ status: 'canceled' })),
      ).toBe('applied');

      const billing = await repo.getWorkspaceBilling('alice');
      expect(billing.plan?.status).toBe('canceled');
      expect(effectivePlanId(billing.plan)).toBe('free');
      expect((await db.doc('subscriptions/sub_1').get()).get('status')).toBe(
        'canceled',
      );
    });

    it("doesn't let another subscription's end touch the current plan", async () => {
      await repo.applySubscription('alice', sub({ id: 'sub_new' }), 'pro');
      expect(
        await repo.endSubscription(
          'alice',
          sub({ id: 'sub_old', status: 'canceled' }),
        ),
      ).toBe('ignored_other_subscription');
      expect(
        effectivePlanId((await repo.getWorkspaceBilling('alice')).plan),
      ).toBe('pro');
    });

    it('reports an unknown workspace', async () => {
      expect(
        await repo.applySubscription(
          'ghost',
          sub({ workspaceId: 'ghost' }),
          'pro',
        ),
      ).toBe('unknown_workspace');
    });

    it('lifts the link limit once Pro is synced (links read the same plan)', async () => {
      const links = new FirestoreLinksRepository(db);
      for (let i = 0; i < 10; i++) {
        await links.create(
          {
            code: `lnk-${i}`,
            workspaceId: 'alice',
            targetUrl: 'https://a.com/',
            title: null,
            createdBy: 'alice',
          },
          'alice',
        );
      }
      await repo.applySubscription('alice', sub(), 'pro');

      await links.create(
        {
          code: 'lnk-pro',
          workspaceId: 'alice',
          targetUrl: 'https://a.com/',
          title: null,
          createdBy: 'alice',
        },
        'alice',
      );
      const usage = await new FirestoreWorkspacesRepository(db).getUsage(
        'alice',
      );
      expect(usage).toMatchObject({ linkCount: 11 });
    });
  });

  describe('event idempotency', () => {
    it('remembers processed events', async () => {
      expect(await repo.isEventProcessed('evt_1')).toBe(false);
      await repo.markEventProcessed('evt_1', 'invoice.paid');
      expect(await repo.isEventProcessed('evt_1')).toBe(true);
    });
  });
});
