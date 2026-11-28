import { Inject, Injectable } from '@nestjs/common';
import type { PaidPlanId, WorkspacePlan } from '@saas-starter/shared';
import {
  FieldValue,
  type Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.tokens';
import {
  isDeletionLocked,
  newPersonalWorkspace,
} from '../workspaces/workspace-docs';
import { toWorkspacePlan } from '../workspaces/workspaces.repository';
import { LIVE_STATUSES, type ProviderSubscription } from './billing.provider';

export interface WorkspaceBilling {
  exists: boolean;
  type: 'personal' | 'team' | null;
  ownerUid: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  plan: WorkspacePlan | null;
  /** Locked by an account deletion in progress (`deletingAt`). */
  deletionLocked: boolean;
}

export type ApplyResult =
  | 'applied'
  /** A different subscription is the workspace's current one; mirror only. */
  | 'ignored_other_subscription'
  /** The subscription's customer isn't this workspace's customer. */
  | 'ignored_customer_mismatch'
  /** The plan doesn't fit the workspace type (Pro: personal, Team: team). */
  | 'ignored_plan_mismatch'
  | 'unknown_workspace';

export abstract class BillingRepository {
  abstract getWorkspaceBilling(workspaceId: string): Promise<WorkspaceBilling>;
  /**
   * Stores the Stripe customer id unless one is already set, and returns the
   * stored one (a concurrent checkout may have won). Creates the personal
   * workspace doc first if needed.
   */
  abstract saveCustomerId(
    workspaceId: string,
    customerId: string,
    personalOwnerUid: string | null,
  ): Promise<string>;
  abstract findWorkspaceIdByCustomer(
    customerId: string,
  ): Promise<string | null>;
  abstract isEventProcessed(eventId: string): Promise<boolean>;
  abstract markEventProcessed(eventId: string, type: string): Promise<void>;
  /**
   * Writes `workspace.plan` (webhooks only) and the `subscriptions` mirror.
   * Known limit: two deliveries for one subscription that run at the same
   * moment can fetch in one order and commit in the other; the next event
   * (Stripe sends several per change) re-syncs the latest state.
   */
  abstract applySubscription(
    workspaceId: string,
    sub: ProviderSubscription,
    planId: PaidPlanId,
  ): Promise<ApplyResult>;
  /**
   * Records that a subscription ended (canceled, unpaid, …). If it is the
   * workspace's current subscription, the plan status follows, whatever the
   * price, so the workspace drops to Free.
   */
  abstract endSubscription(
    workspaceId: string,
    sub: ProviderSubscription,
  ): Promise<ApplyResult>;
}

@Injectable()
export class FirestoreBillingRepository extends BillingRepository {
  constructor(@Inject(FIRESTORE) private readonly db: Firestore) {
    super();
  }

  private workspace(id: string) {
    return this.db.collection('workspaces').doc(id);
  }

  async getWorkspaceBilling(workspaceId: string): Promise<WorkspaceBilling> {
    const snap = await this.workspace(workspaceId).get();
    const str = (key: string) => {
      const value = snap.get(key);
      return typeof value === 'string' && value ? value : null;
    };
    const type = snap.get('type');
    return {
      exists: snap.exists,
      type: type === 'personal' || type === 'team' ? type : null,
      ownerUid: str('ownerUid'),
      stripeCustomerId: str('stripeCustomerId'),
      stripeSubscriptionId: str('stripeSubscriptionId'),
      plan: toWorkspacePlan(snap.get('plan')),
      deletionLocked: isDeletionLocked(snap.get('deletingAt'), new Date()),
    };
  }

  async saveCustomerId(
    workspaceId: string,
    customerId: string,
    personalOwnerUid: string | null,
  ): Promise<string> {
    const ref = this.workspace(workspaceId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.get('stripeCustomerId');
      if (typeof existing === 'string' && existing) return existing;

      if (snap.exists) {
        tx.update(ref, { stripeCustomerId: customerId });
      } else if (personalOwnerUid) {
        tx.create(ref, {
          ...newPersonalWorkspace(personalOwnerUid),
          stripeCustomerId: customerId,
        });
      } else {
        throw new Error(`Workspace ${workspaceId} does not exist`);
      }
      return customerId;
    });
  }

  async findWorkspaceIdByCustomer(customerId: string): Promise<string | null> {
    const snap = await this.db
      .collection('workspaces')
      .where('stripeCustomerId', '==', customerId)
      .limit(1)
      .get();
    return snap.docs[0]?.id ?? null;
  }

  async isEventProcessed(eventId: string): Promise<boolean> {
    return (await this.db.collection('stripeEvents').doc(eventId).get()).exists;
  }

  async markEventProcessed(eventId: string, type: string): Promise<void> {
    await this.db
      .collection('stripeEvents')
      .doc(eventId)
      .set({ type, processedAt: FieldValue.serverTimestamp() });
  }

  async applySubscription(
    workspaceId: string,
    sub: ProviderSubscription,
    planId: PaidPlanId,
  ): Promise<ApplyResult> {
    const ref = this.workspace(workspaceId);
    const mirrorRef = this.db.collection('subscriptions').doc(sub.id);
    const periodEnd = sub.currentPeriodEnd
      ? Timestamp.fromDate(sub.currentPeriodEnd)
      : null;

    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return 'unknown_workspace';

      const knownCustomer = snap.get('stripeCustomerId');
      if (
        typeof knownCustomer === 'string' &&
        knownCustomer &&
        knownCustomer !== sub.customerId
      ) {
        return 'ignored_customer_mismatch';
      }

      // Always keep the mirror (admin revenue stats) current.
      tx.set(mirrorRef, {
        workspaceId,
        plan: planId,
        status: sub.status,
        amount: sub.amount,
        currency: sub.currency,
        interval: sub.interval,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        updatedAt: FieldValue.serverTimestamp(),
      });

      // Pro belongs on personal workspaces and Team on teams, whatever price
      // a portal or dashboard change put on the subscription.
      const isTeam = snap.get('type') === 'team';
      if ((planId === 'team') !== isTeam) return 'ignored_plan_mismatch';

      // An old, ended subscription must not overwrite the current one (e.g.
      // after a re-subscribe); a live one becomes the workspace's plan.
      const current = snap.get('stripeSubscriptionId');
      if (current && current !== sub.id && !LIVE_STATUSES.has(sub.status)) {
        return 'ignored_other_subscription';
      }

      tx.update(ref, {
        plan: {
          id: planId,
          status: sub.status,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        },
        stripeSubscriptionId: sub.id,
        stripeCustomerId: sub.customerId,
      });
      return 'applied';
    });
  }

  async endSubscription(
    workspaceId: string,
    sub: ProviderSubscription,
  ): Promise<ApplyResult> {
    const ref = this.workspace(workspaceId);
    const mirrorRef = this.db.collection('subscriptions').doc(sub.id);

    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return 'unknown_workspace';

      const knownCustomer = snap.get('stripeCustomerId');
      if (
        typeof knownCustomer === 'string' &&
        knownCustomer &&
        knownCustomer !== sub.customerId
      ) {
        return 'ignored_customer_mismatch';
      }

      tx.set(
        mirrorRef,
        {
          workspaceId,
          status: sub.status,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      const current = snap.get('stripeSubscriptionId');
      if (current && current !== sub.id) return 'ignored_other_subscription';

      // Keep plan.id for history; the ended status makes the effective plan Free.
      const plan = toWorkspacePlan(snap.get('plan'));
      tx.update(ref, {
        plan: {
          id: plan?.id ?? 'free',
          status: sub.status,
          currentPeriodEnd: sub.currentPeriodEnd
            ? Timestamp.fromDate(sub.currentPeriodEnd)
            : null,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        },
        stripeSubscriptionId: sub.id,
      });
      return 'applied';
    });
  }
}
