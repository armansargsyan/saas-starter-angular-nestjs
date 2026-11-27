/**
 * Admin and audit-log repositories against the Firestore emulator. Skipped
 * unless FIRESTORE_EMULATOR_HOST is set; run with `npx nx test-firestore api`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import {
  type Firestore,
  getFirestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { FirestoreAdminRepository } from './admin.repository';
import { FirestoreAuditLogRepository } from './audit-log.repository';

const host = process.env['FIRESTORE_EMULATOR_HOST'];
const PROJECT = 'demo-links-test';

describe.skipIf(!host)('FirestoreAdminRepository (emulator)', () => {
  let app: App;
  let db: Firestore;
  let repo: FirestoreAdminRepository;

  const user = (uid: string, email: string, createdAt: string, extra = {}) =>
    db.doc(`users/${uid}`).set({
      email,
      displayName: null,
      role: 'user',
      status: 'active',
      createdAt: Timestamp.fromDate(new Date(createdAt)),
      ...extra,
    });

  beforeAll(() => {
    app = initializeApp({ projectId: PROJECT }, 'admin-repo-spec');
    db = getFirestore(app);
    repo = new FirestoreAdminRepository(db);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  beforeEach(async () => {
    await fetch(
      `http://${host}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
      { method: 'DELETE' },
    );
    await user('u-ada', 'ada@example.com', '2026-06-01T10:00:00Z');
    await user('u-bob', 'bob@example.com', '2026-06-05T10:00:00Z', {
      status: 'banned',
    });
    await user('u-bea', 'bea@example.com', '2026-06-09T10:00:00Z', {
      role: 'admin',
    });
    await db.doc('workspaces/u-bob').set({
      type: 'personal',
      linkCount: 7,
      plan: {
        id: 'pro',
        status: 'active',
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      },
    });
  });

  it('pages users by email, joined with their personal workspace', async () => {
    const first = await repo.listUsers(undefined, 2, undefined);
    expect(first.items.map((u) => u.email)).toEqual([
      'ada@example.com',
      'bea@example.com',
    ]);
    expect(first.nextCursor).toBe('u-bea');

    const second = await repo.listUsers(
      undefined,
      2,
      first.nextCursor ?? undefined,
    );
    expect(second.items).toEqual([
      expect.objectContaining({
        uid: 'u-bob',
        status: 'banned',
        linkCount: 7,
        plan: expect.objectContaining({ id: 'pro' }),
      }),
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it('reports a cursor whose profile was deleted', async () => {
    expect(await repo.listUsers(undefined, 2, 'deleted-uid')).toBeNull();
  });

  it('searches by email prefix', async () => {
    const { items } = await repo.listUsers('b', 10, undefined);
    expect(items.map((u) => u.uid)).toEqual(['u-bea', 'u-bob']);
    expect((await repo.listUsers('zz', 10, undefined)).items).toEqual([]);
  });

  it('reads one user, sets status, and ignores a missing profile', async () => {
    expect(await repo.getUser('u-bea')).toMatchObject({
      role: 'admin',
      linkCount: 0,
      plan: null,
    });
    expect(await repo.getUser('nobody')).toBeNull();

    await repo.setStatus('u-ada', 'banned');
    expect((await repo.getUser('u-ada'))?.status).toBe('banned');
    await expect(repo.setStatus('nobody', 'banned')).resolves.toBeUndefined();
  });

  it('reads live subscriptions and signups since a date', async () => {
    await db.doc('subscriptions/s1').set({
      plan: 'pro',
      status: 'active',
      amount: 900,
      currency: 'usd',
      interval: 'month',
    });
    await db.doc('subscriptions/s2').set({
      plan: 'team',
      status: 'canceled',
      amount: 2900,
      currency: 'usd',
      interval: 'month',
    });
    await db.doc('subscriptions/s3').set({
      plan: 'team',
      status: 'past_due',
      amount: 2900,
      currency: 'usd',
      interval: 'month',
    });

    const subs = await repo.subscriptions(['active', 'past_due']);
    expect(subs.map((s) => s.plan).sort()).toEqual(['pro', 'team']);

    expect(
      await repo.countSignups(
        new Date('2026-06-05T00:00:00Z'),
        new Date('2026-06-06T00:00:00Z'),
      ),
    ).toBe(1);
    expect(
      await repo.countSignups(
        new Date('2026-06-01T00:00:00Z'),
        new Date('2026-06-10T00:00:00Z'),
      ),
    ).toBe(3);
  });

  it('writes audit entries as pending, then applied or failed', async () => {
    const audit = new FirestoreAuditLogRepository(db);
    const id = await audit.begin({
      actorUid: 'admin-1',
      action: 'user.ban',
      targetUid: 'u-bob',
    });
    expect((await db.doc(`auditLog/${id}`).get()).data()).toMatchObject({
      actorUid: 'admin-1',
      action: 'user.ban',
      targetUid: 'u-bob',
      status: 'pending',
    });

    await audit.finish(id, 'failed', { error: 'boom', completed: ['status'] });
    expect((await db.doc(`auditLog/${id}`).get()).data()).toMatchObject({
      status: 'failed',
      error: 'boom',
      completed: ['status'],
    });
  });
});
