/**
 * FirestoreLinksRepository against the Firestore emulator. Skipped unless
 * FIRESTORE_EMULATOR_HOST is set; run with `npx nx test-firestore api`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { FirestoreWorkspacesRepository } from '../workspaces/workspaces.repository';
import {
  CodeTakenError,
  FirestoreLinksRepository,
  type NewLink,
  PlanLimitError,
  WorkspaceNotFoundError,
} from './links.repository';

const host = process.env['FIRESTORE_EMULATOR_HOST'];
const PROJECT = 'demo-links-test';
// Contending transactions queue on the emulator's locks before retrying.
const CONTENDED_TIMEOUT_MS = 60_000;

const link = (code: string, workspaceId = 'alice'): NewLink => ({
  code,
  workspaceId,
  targetUrl: `https://example.com/${code}`,
  title: null,
  createdBy: workspaceId,
});

describe.skipIf(!host)('FirestoreLinksRepository (emulator)', () => {
  let app: App;
  let db: Firestore;
  let repo: FirestoreLinksRepository;

  const linkCount = async (workspaceId: string) =>
    (await db.doc(`workspaces/${workspaceId}`).get()).get('linkCount');

  beforeAll(() => {
    app = initializeApp({ projectId: PROJECT }, 'links-repo-spec');
    db = getFirestore(app);
    repo = new FirestoreLinksRepository(db);
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

  describe('create', () => {
    it('creates the personal workspace on first use, then increments linkCount', async () => {
      const first = await repo.create(link('first'), 'alice');
      await repo.create(link('second'), 'alice');

      expect(first).toMatchObject({
        code: 'first',
        workspaceId: 'alice',
        clickCount: 0,
      });
      expect(first.createdAt).toBeInstanceOf(Date);
      const workspace = (await db.doc('workspaces/alice').get()).data();
      expect(workspace).toMatchObject({
        type: 'personal',
        ownerUid: 'alice',
        linkCount: 2,
      });
    });

    it('refuses a taken code without touching linkCount', async () => {
      await repo.create(link('dup'), 'alice');
      await expect(
        repo.create(link('dup', 'bob'), 'bob'),
      ).rejects.toBeInstanceOf(CodeTakenError);
      expect((await db.doc('workspaces/bob').get()).exists).toBe(false);
    });

    it(
      'lets exactly one of several concurrent creates of a code win',
      async () => {
        const results = await Promise.allSettled(
          ['u1', 'u2', 'u3', 'u4', 'u5'].map((uid) =>
            repo.create(link('race', uid), uid),
          ),
        );
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        for (const r of results) {
          if (r.status === 'rejected')
            expect(r.reason).toBeInstanceOf(CodeTakenError);
        }
      },
      CONTENDED_TIMEOUT_MS,
    );

    it(
      'survives concurrent first links that both create the personal workspace',
      async () => {
        await Promise.all([
          repo.create(link('one'), 'alice'),
          repo.create(link('two'), 'alice'),
        ]);
        expect(await linkCount('alice')).toBe(2);
      },
      CONTENDED_TIMEOUT_MS,
    );

    it('refuses a missing non-personal workspace', async () => {
      await expect(
        repo.create(link('x1', 'team-1'), null),
      ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    });
  });

  describe('plan limits', () => {
    const fill = async (n: number, workspaceId = 'alice') => {
      for (let i = 0; i < n; i++) {
        await repo.create(
          link(`${workspaceId}-${i}`, workspaceId),
          workspaceId,
        );
      }
    };
    const setPlan = (id: string, status: string, workspaceId = 'alice') =>
      db.doc(`workspaces/${workspaceId}`).update({
        plan: { id, status, currentPeriodEnd: null, cancelAtPeriodEnd: false },
      });

    it('allows exactly 10 links on Free (no plan)', async () => {
      await fill(10);
      await expect(repo.create(link('eleventh'), 'alice')).rejects.toEqual(
        new PlanLimitError('free', 10),
      );
      expect(await linkCount('alice')).toBe(10);
      expect(await repo.get('eleventh')).toBeNull();
    });

    it(
      'cannot be overshot by concurrent creates at the boundary',
      async () => {
        await fill(8);
        const results = await Promise.allSettled(
          [0, 1, 2, 3, 4, 5].map((i) =>
            repo.create(link(`burst-${i}`), 'alice'),
          ),
        );

        const ok = results.filter((r) => r.status === 'fulfilled');
        expect(ok).toHaveLength(2);
        for (const r of results) {
          if (r.status === 'rejected')
            expect(r.reason).toBeInstanceOf(PlanLimitError);
        }
        expect(await linkCount('alice')).toBe(10);
        const stored = await db
          .collection('links')
          .where('workspaceId', '==', 'alice')
          .get();
        expect(stored.size).toBe(10);
      },
      CONTENDED_TIMEOUT_MS,
    );

    it('has no link limit on an active (or past_due) Pro plan', async () => {
      await fill(10);
      await setPlan('pro', 'active');
      await repo.create(link('pro-11'), 'alice');
      await setPlan('pro', 'past_due');
      await repo.create(link('pro-12'), 'alice');
      expect(await linkCount('alice')).toBe(12);
    });

    it('after a downgrade keeps existing links but blocks new ones', async () => {
      await fill(10);
      await setPlan('pro', 'active');
      await repo.create(link('extra-1'), 'alice');
      await repo.create(link('extra-2'), 'alice');
      await setPlan('pro', 'canceled');

      await expect(
        repo.create(link('extra-3'), 'alice'),
      ).rejects.toBeInstanceOf(PlanLimitError);
      expect(await repo.get('extra-1')).not.toBeNull();

      // Back under the limit only after deleting enough.
      for (const code of ['extra-1', 'extra-2', 'alice-0'])
        await repo.delete(code);
      await repo.create(link('fits-again'), 'alice');
      expect(await linkCount('alice')).toBe(10);
    });
  });

  describe('clicks and stats', () => {
    it('aggregates per day with dotted referrer hosts as map keys, bots apart', async () => {
      await repo.create(link('clicky'), 'alice');
      const at = new Date('2026-06-10T10:00:00Z');
      await repo.recordClick('clicky', {
        at,
        device: 'desktop',
        referrerHost: 'news.example.org',
        country: 'DE',
      });
      await repo.recordClick('clicky', {
        at,
        device: 'mobile',
        referrerHost: null,
        country: null,
      });
      await repo.recordClick('clicky', {
        at,
        device: 'bot',
        referrerHost: 'x.com',
        country: 'US',
      });
      await repo.recordClick('clicky', {
        at: new Date('2026-06-01T00:00:00Z'),
        device: 'desktop',
        referrerHost: null,
        country: null,
      });

      expect(await repo.dailyStats('clicky', '2026-06-05')).toEqual([
        {
          date: '2026-06-10',
          count: 2,
          bots: 1,
          referrers: { 'news.example.org': 1 },
          countries: { DE: 1 },
          devices: { desktop: 1, mobile: 1 },
        },
      ]);
      const stored = await repo.get('clicky');
      expect(stored).toMatchObject({ clickCount: 3, botClickCount: 1 });
      const raw = await db.collection('links/clicky/clicks').get();
      expect(raw.size).toBe(3); // humans only
      expect(raw.docs[0].get('expireAt')).toBeDefined();
      expect(raw.docs[0].data()).not.toHaveProperty('ip');
    });
  });

  describe('delete', () => {
    it('decrements linkCount, removes analytics and retires the code', async () => {
      await repo.create(link('bye'), 'alice');
      await repo.recordClick('bye', {
        at: new Date(),
        device: 'desktop',
        referrerHost: null,
        country: null,
      });

      expect(await repo.delete('bye')).toBe(true);

      expect(await repo.get('bye')).toBeNull();
      expect(await linkCount('alice')).toBe(0);
      expect((await db.collection('links/bye/daily').get()).size).toBe(0);
      expect((await db.collection('links/bye/clicks').get()).size).toBe(0);
      await expect(
        repo.create(link('bye', 'bob'), 'bob'),
      ).rejects.toBeInstanceOf(CodeTakenError);
      expect(await repo.delete('bye')).toBe(false);
    });
  });

  it('deletes a link whose workspace doc is gone', async () => {
    await repo.create(link('orphan'), 'alice');
    await db.doc('workspaces/alice').delete();

    expect(await repo.delete('orphan')).toBe(true);
    expect((await db.doc('workspaces/alice').get()).exists).toBe(false);
  });

  describe('list and update', () => {
    it('pages newest first and ignores a cursor from another workspace', async () => {
      for (const code of ['l-one', 'l-two', 'l-three']) {
        await repo.create(link(code), 'alice');
      }
      await repo.create(link('b-one', 'bob'), 'bob');

      const page1 = await repo.listByWorkspace('alice', 2, undefined);
      expect(page1.items.map((l) => l.code)).toEqual(['l-three', 'l-two']);
      const page2 = await repo.listByWorkspace(
        'alice',
        2,
        page1.nextCursor ?? undefined,
      );
      expect(page2).toMatchObject({
        items: [{ code: 'l-one' }],
        nextCursor: null,
      });

      const foreign = await repo.listByWorkspace('alice', 2, 'b-one');
      expect(foreign.items.map((l) => l.code)).toEqual(['l-three', 'l-two']);
    });

    it('updates fields and reports a missing link as null', async () => {
      await repo.create(link('upd'), 'alice');
      expect(await repo.update('upd', { title: 'New' })).toMatchObject({
        title: 'New',
      });
      expect(await repo.update('nope', { title: 'x' })).toBeNull();
    });
  });

  describe('workspace usage', () => {
    it('reads counts and the stored plan; null before the workspace exists', async () => {
      const workspaces = new FirestoreWorkspacesRepository(db);
      expect(await workspaces.getUsage('alice')).toBeNull();

      await repo.create(link('u-1'), 'alice');
      await repo.create(link('u-2'), 'alice');
      expect(await workspaces.getUsage('alice')).toEqual({
        plan: null,
        linkCount: 2,
        memberCount: 1,
      });
    });
  });

  describe('workspace membership', () => {
    it('is true only with a members doc', async () => {
      const workspaces = new FirestoreWorkspacesRepository(db);
      await db.doc('workspaces/team-1/members/bob').set({ role: 'member' });

      expect(await workspaces.isMember('team-1', 'bob')).toBe(true);
      expect(await workspaces.isMember('team-1', 'alice')).toBe(false);
    });
  });
});
