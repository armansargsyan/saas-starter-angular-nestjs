import { Inject, Injectable } from '@nestjs/common';
import type { UserStatus, WorkspacePlan } from '@saas-starter/shared';
import {
  type Firestore,
  type Query,
  Timestamp,
} from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.tokens';
import { toWorkspacePlan } from '../workspaces/workspaces.repository';

export interface AdminUserRecord {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: 'user' | 'admin';
  status: UserStatus;
  createdAt: Date | null;
  /** From the personal workspace `workspaces/{uid}`. */
  plan: WorkspacePlan | null;
  linkCount: number;
}

export interface SubscriptionRecord {
  plan: string;
  status: string;
  amount: number | null;
  currency: string | null;
  interval: string | null;
}

export abstract class AdminRepository {
  /**
   * Users ordered by email (profiles store it lowercased; users without an
   * email aren't listed). `emailPrefix` filters; `cursor` is the last uid of
   * the previous page, and null comes back if that profile no longer exists.
   */
  abstract listUsers(
    emailPrefix: string | undefined,
    limit: number,
    cursor: string | undefined,
  ): Promise<{ items: AdminUserRecord[]; nextCursor: string | null } | null>;
  abstract getUser(uid: string): Promise<AdminUserRecord | null>;
  /** Mirrors the ban in `users/{uid}.status` (if the profile exists). */
  abstract setStatus(uid: string, status: UserStatus): Promise<void>;
  /** `subscriptions` in the given statuses (the webhook-synced mirror). */
  abstract subscriptions(
    statuses: readonly string[],
  ): Promise<SubscriptionRecord[]>;
  /** Profiles created in [from, to) (from `users/{uid}.createdAt`), via a count aggregation. */
  abstract countSignups(from: Date, to: Date): Promise<number>;
}

/** Above this many live subscriptions, MRR should move to a pre-aggregated counter. */
export const MAX_SUBSCRIPTIONS_SCANNED = 10_000;
const NOT_FOUND = 5;

@Injectable()
export class FirestoreAdminRepository extends AdminRepository {
  constructor(@Inject(FIRESTORE) private readonly db: Firestore) {
    super();
  }

  async listUsers(
    emailPrefix: string | undefined,
    limit: number,
    cursor: string | undefined,
  ) {
    const users = this.db.collection('users');
    let query: Query = users.orderBy('email').limit(limit + 1);
    if (emailPrefix) {
      query = query
        .where('email', '>=', emailPrefix)
        .where('email', '<', `${emailPrefix}\uf8ff`);
    }
    if (cursor) {
      const after = await users.doc(cursor).get();
      if (!after.exists) return null;
      query = query.startAfter(after);
    }
    const docs = (await query.get()).docs;
    const page = docs.slice(0, limit);
    const workspaces = page.length
      ? await this.db.getAll(
          ...page.map((doc) => this.db.collection('workspaces').doc(doc.id)),
        )
      : [];
    return {
      items: page.map((doc, i) =>
        toRecord(doc.id, doc.data(), workspaces[i]?.data()),
      ),
      nextCursor: docs.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async getUser(uid: string): Promise<AdminUserRecord | null> {
    const [user, workspace] = await this.db.getAll(
      this.db.collection('users').doc(uid),
      this.db.collection('workspaces').doc(uid),
    );
    return user.exists
      ? toRecord(uid, user.data() ?? {}, workspace.data())
      : null;
  }

  async setStatus(uid: string, status: UserStatus): Promise<void> {
    try {
      await this.db.collection('users').doc(uid).update({ status });
    } catch (err) {
      // No profile yet (never called /me): the Auth-side ban still applies.
      if ((err as { code?: unknown }).code !== NOT_FOUND) throw err;
    }
  }

  async subscriptions(
    statuses: readonly string[],
  ): Promise<SubscriptionRecord[]> {
    const snap = await this.db
      .collection('subscriptions')
      .where('status', 'in', [...statuses])
      .limit(MAX_SUBSCRIPTIONS_SCANNED)
      .get();
    return snap.docs.map((doc) => {
      const data = doc.data();
      return {
        plan: String(data['plan'] ?? ''),
        status: String(data['status'] ?? ''),
        amount: typeof data['amount'] === 'number' ? data['amount'] : null,
        currency:
          typeof data['currency'] === 'string' ? data['currency'] : null,
        interval:
          typeof data['interval'] === 'string' ? data['interval'] : null,
      };
    });
  }

  async countSignups(from: Date, to: Date): Promise<number> {
    const snap = await this.db
      .collection('users')
      .where('createdAt', '>=', Timestamp.fromDate(from))
      .where('createdAt', '<', Timestamp.fromDate(to))
      .count()
      .get();
    return snap.data().count;
  }
}

function toRecord(
  uid: string,
  user: Record<string, unknown>,
  workspace: Record<string, unknown> | undefined,
): AdminUserRecord {
  const str = (value: unknown) => (typeof value === 'string' ? value : null);
  const createdAt = user['createdAt'];
  const linkCount = workspace?.['linkCount'];
  return {
    uid,
    email: str(user['email']),
    displayName: str(user['displayName']),
    role: user['role'] === 'admin' ? 'admin' : 'user',
    status: user['status'] === 'banned' ? 'banned' : 'active',
    createdAt: createdAt instanceof Timestamp ? createdAt.toDate() : null,
    plan: toWorkspacePlan(workspace?.['plan']),
    linkCount: typeof linkCount === 'number' ? linkCount : 0,
  };
}
