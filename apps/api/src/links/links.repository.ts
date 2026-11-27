import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DeviceType } from '@saas-starter/shared';
import {
  FieldPath,
  FieldValue,
  type Firestore,
  type Query,
  Timestamp,
} from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.tokens';
import { utcDay } from './click-info';

/** `links/{code}`; the doc id is the short code. */
export interface StoredLink {
  code: string;
  workspaceId: string;
  targetUrl: string;
  title: string | null;
  createdBy: string;
  createdAt: Date;
  clickCount: number;
  botClickCount: number;
  lastClickedAt: Date | null;
}

export interface NewLink {
  code: string;
  workspaceId: string;
  targetUrl: string;
  title: string | null;
  createdBy: string;
}

export interface Click {
  at: Date;
  device: DeviceType;
  referrerHost: string | null;
  country: string | null;
}

/** `links/{code}/daily/{yyyy-mm-dd}`. */
export interface DailyStats {
  date: string;
  count: number;
  bots: number;
  referrers: Record<string, number>;
  countries: Record<string, number>;
  devices: Partial<Record<DeviceType, number>>;
}

/** The code is in use, or was used by a link that has since been deleted. */
export class CodeTakenError extends Error {
  constructor(code: string) {
    super(`Short code "${code}" is taken`);
  }
}

export class WorkspaceNotFoundError extends Error {
  constructor(workspaceId: string) {
    super(`Workspace ${workspaceId} does not exist`);
  }
}

export abstract class LinksRepository {
  /**
   * Creates the link and bumps the workspace's `linkCount` in one transaction.
   * Creates the personal workspace (id = owner uid) on first use.
   * @throws CodeTakenError also for retired (previously deleted) codes
   * @throws WorkspaceNotFoundError
   */
  abstract create(
    link: NewLink,
    personalOwnerUid: string | null,
  ): Promise<StoredLink>;
  abstract get(code: string): Promise<StoredLink | null>;
  /** Newest first. `cursor` is the code of the last link of the previous page. */
  abstract listByWorkspace(
    workspaceId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<{ items: StoredLink[]; nextCursor: string | null }>;
  abstract update(
    code: string,
    patch: { targetUrl?: string; title?: string | null },
  ): Promise<StoredLink | null>;
  /**
   * Deletes the link (decrementing `linkCount`) and its analytics, and
   * retires the code: it is never issued again, so links already shared or
   * printed can't be taken over by someone else.
   */
  abstract delete(code: string): Promise<boolean>;
  /**
   * One batched write: link counters, the daily aggregate and (humans) the
   * raw click. Known limit: every click on a link writes the same two docs,
   * so a single very hot link is capped by Firestore's per-document write
   * rate (~1/s sustained); excess clicks are dropped and logged, redirects
   * are unaffected. Sharded counters would lift this if ever needed.
   */
  abstract recordClick(code: string, click: Click): Promise<void>;
  /** Daily aggregates with `date >= sinceDay`, oldest first. */
  abstract dailyStats(code: string, sinceDay: string): Promise<DailyStats[]>;
}

/** Raw clicks expire through a Firestore TTL policy on `expireAt`. */
export const RAW_CLICK_TTL_DAYS = 90;
const DAY_MS = 86_400_000;
const ALREADY_EXISTS = 6;
const NOT_FOUND = 5;

@Injectable()
export class FirestoreLinksRepository extends LinksRepository {
  private readonly logger = new Logger(FirestoreLinksRepository.name);

  constructor(@Inject(FIRESTORE) private readonly db: Firestore) {
    super();
  }

  private links() {
    return this.db.collection('links');
  }

  /** `retiredCodes/{code}`: codes of deleted links, never reissued. */
  private retired(code: string) {
    return this.db.collection('retiredCodes').doc(code);
  }

  async create(
    link: NewLink,
    personalOwnerUid: string | null,
  ): Promise<StoredLink> {
    // Two attempts: a concurrent first link may create the personal
    // workspace between our read and commit; the retry then sees it.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.createInTransaction(link, personalOwnerUid);
        break;
      } catch (err) {
        if ((err as { code?: unknown }).code !== ALREADY_EXISTS) throw err;
        // Which create() collided? Only the link's means "code taken".
        if (await this.isCodeUsed(link.code)) {
          throw new CodeTakenError(link.code);
        }
        if (attempt >= 2) throw err;
      }
    }

    const created = await this.get(link.code);
    if (!created) throw new Error(`Link ${link.code} vanished after create`);
    return created;
  }

  private async createInTransaction(
    link: NewLink,
    personalOwnerUid: string | null,
  ): Promise<void> {
    const linkRef = this.links().doc(link.code);
    const workspaceRef = this.db.collection('workspaces').doc(link.workspaceId);

    await this.db.runTransaction(async (tx) => {
      const [existing, retired, workspace] = await Promise.all([
        tx.get(linkRef),
        tx.get(this.retired(link.code)),
        tx.get(workspaceRef),
      ]);
      if (existing.exists || retired.exists) {
        throw new CodeTakenError(link.code);
      }

      // Plan limits (#5) are checked here, against `workspace`.
      if (workspace.exists) {
        tx.update(workspaceRef, { linkCount: FieldValue.increment(1) });
      } else if (personalOwnerUid) {
        tx.create(workspaceRef, {
          type: 'personal',
          name: 'Personal',
          ownerUid: personalOwnerUid,
          plan: null,
          linkCount: 1,
          memberCount: 1,
          createdAt: FieldValue.serverTimestamp(),
        });
      } else {
        throw new WorkspaceNotFoundError(link.workspaceId);
      }

      tx.create(linkRef, {
        workspaceId: link.workspaceId,
        targetUrl: link.targetUrl,
        title: link.title,
        createdBy: link.createdBy,
        createdAt: FieldValue.serverTimestamp(),
        clickCount: 0,
        botClickCount: 0,
        lastClickedAt: null,
      });
    });
  }

  private async isCodeUsed(code: string): Promise<boolean> {
    const [link, retired] = await Promise.all([
      this.links().doc(code).get(),
      this.retired(code).get(),
    ]);
    return link.exists || retired.exists;
  }

  async get(code: string): Promise<StoredLink | null> {
    const snap = await this.links().doc(code).get();
    return snap.exists ? toStoredLink(code, snap.data() ?? {}) : null;
  }

  async listByWorkspace(
    workspaceId: string,
    limit: number,
    cursor: string | undefined,
  ) {
    let query: Query = this.links()
      .where('workspaceId', '==', workspaceId)
      .orderBy('createdAt', 'desc')
      .limit(limit + 1);

    if (cursor) {
      const after = await this.links().doc(cursor).get();
      // A cursor from another workspace (or a deleted link) is ignored.
      if (after.exists && after.get('workspaceId') === workspaceId) {
        query = query.startAfter(after);
      }
    }

    const docs = (await query.get()).docs;
    const page = docs.slice(0, limit);
    return {
      items: page.map((doc) => toStoredLink(doc.id, doc.data())),
      nextCursor: docs.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async update(
    code: string,
    patch: { targetUrl?: string; title?: string | null },
  ): Promise<StoredLink | null> {
    const fields = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    try {
      await this.links().doc(code).update(fields);
    } catch (err) {
      if ((err as { code?: unknown }).code === NOT_FOUND) return null;
      throw err;
    }
    return this.get(code);
  }

  async delete(code: string): Promise<boolean> {
    const linkRef = this.links().doc(code);
    const deleted = await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(linkRef);
      if (!snap.exists) return false;
      const workspaceId = snap.get('workspaceId') as string;
      const workspaceRef = this.db.collection('workspaces').doc(workspaceId);
      const workspace = await tx.get(workspaceRef);
      tx.delete(linkRef);
      tx.create(this.retired(code), {
        workspaceId,
        retiredAt: FieldValue.serverTimestamp(),
      });
      // A link can outlive its workspace doc (e.g. a deleted team): still
      // let it be deleted.
      if (workspace.exists) {
        tx.update(workspaceRef, { linkCount: FieldValue.increment(-1) });
      }
      return true;
    });

    if (deleted) {
      // Subcollections outlive their parent; remove the analytics. Only the
      // subcollections: the code is retired, so nothing new can appear here.
      // Best effort: the delete itself already succeeded.
      try {
        await Promise.all([
          this.db.recursiveDelete(linkRef.collection('daily')),
          this.db.recursiveDelete(linkRef.collection('clicks')),
        ]);
      } catch (err) {
        this.logger.warn(
          `Analytics cleanup for ${code} failed: ${(err as Error).message}`,
        );
      }
    }
    return deleted;
  }

  async recordClick(code: string, click: Click): Promise<void> {
    const linkRef = this.links().doc(code);
    const dailyRef = linkRef.collection('daily').doc(utcDay(click.at));
    const at = Timestamp.fromDate(click.at);
    const one = FieldValue.increment(1);
    const batch = this.db.batch();

    if (click.device === 'bot') {
      batch.update(linkRef, { botClickCount: one });
      batch.set(dailyRef, { bots: one }, { merge: true });
    } else {
      batch.update(linkRef, { clickCount: one, lastClickedAt: at });
      // set+merge with nested maps: keys like "example.com" stay map keys
      // (update() would treat the dots as field paths).
      batch.set(
        dailyRef,
        {
          count: one,
          devices: { [click.device]: one },
          ...(click.referrerHost && {
            referrers: { [click.referrerHost]: one },
          }),
          ...(click.country && { countries: { [click.country]: one } }),
        },
        { merge: true },
      );
      batch.create(linkRef.collection('clicks').doc(), {
        at,
        device: click.device,
        referrerHost: click.referrerHost,
        country: click.country,
        expireAt: Timestamp.fromMillis(
          click.at.getTime() + RAW_CLICK_TTL_DAYS * DAY_MS,
        ),
      });
    }
    await batch.commit();
  }

  async dailyStats(code: string, sinceDay: string): Promise<DailyStats[]> {
    const snap = await this.links()
      .doc(code)
      .collection('daily')
      .where(FieldPath.documentId(), '>=', sinceDay)
      .orderBy(FieldPath.documentId())
      .get();
    return snap.docs.map((doc) => {
      const data = doc.data();
      return {
        date: doc.id,
        count: num(data['count']),
        bots: num(data['bots']),
        referrers: counts(data['referrers']),
        countries: counts(data['countries']),
        devices: counts(data['devices']),
      };
    });
  }
}

function toStoredLink(code: string, data: Record<string, unknown>): StoredLink {
  return {
    code,
    workspaceId: String(data['workspaceId']),
    targetUrl: String(data['targetUrl']),
    title: typeof data['title'] === 'string' ? data['title'] : null,
    createdBy: String(data['createdBy']),
    // serverTimestamp() reads back as null only in the same instant it's
    // written by another client; fall back to now rather than crash.
    createdAt: toDate(data['createdAt']) ?? new Date(),
    clickCount: num(data['clickCount']),
    botClickCount: num(data['botClickCount']),
    lastClickedAt: toDate(data['lastClickedAt']),
  };
}

function toDate(value: unknown): Date | null {
  return value instanceof Timestamp ? value.toDate() : null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function counts(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  );
}
