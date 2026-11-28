/**
 * FirestoreAccountRepository against the Firestore emulator. Skipped unless
 * FIRESTORE_EMULATOR_HOST is set; run with `npx nx test-firestore api`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { FirestoreLinksRepository } from '../links/links.repository';
import { FirestoreTeamsRepository } from '../teams/teams.repository';
import {
  FirestoreAccountRepository,
  TeamHasMembersError,
  TeamNotOwnedError,
} from './account.repository';

const host = process.env['FIRESTORE_EMULATOR_HOST'];
const PROJECT = 'demo-links-test';

describe.skipIf(!host)('FirestoreAccountRepository (emulator)', () => {
  let app: App;
  let db: Firestore;
  let repo: FirestoreAccountRepository;
  let links: FirestoreLinksRepository;
  let teams: FirestoreTeamsRepository;

  beforeAll(async () => {
    app = initializeApp({ projectId: PROJECT }, 'account-repo-spec');
    db = getFirestore(app);
    repo = new FirestoreAccountRepository(db);
    links = new FirestoreLinksRepository(db);
    teams = new FirestoreTeamsRepository(db);
    // The first request waits for a (failing) credentials lookup: pay it
    // here, not inside the first test's timeout.
    await db.doc('warmup/x').get();
  }, 30_000);

  afterAll(async () => {
    await deleteApp(app);
  });

  beforeEach(async () => {
    await fetch(
      `http://${host}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
      { method: 'DELETE' },
    );
  });

  const link = (code: string, workspaceId: string, owner: string | null) =>
    links.create(
      {
        code,
        workspaceId,
        targetUrl: 'https://example.com/',
        title: null,
        createdBy: owner ?? 'alice',
      },
      owner,
    );

  const click = (code: string) =>
    links.recordClick(code, {
      at: new Date(),
      device: 'desktop',
      referrerHost: null,
      country: null,
    });

  const exists = async (path: string) => (await db.doc(path).get()).exists;
  const count = async (path: string) =>
    (await db.collection(path).count().get()).data().count;

  it('deletes links, analytics, mirrors and the workspace, and retires the codes', async () => {
    await link('alice-1', 'alice', 'alice');
    await link('alice-2', 'alice', 'alice');
    await link('bob-1', 'bob', 'bob');
    await click('alice-1');
    await db.doc('workspaces/alice').update({ stripeCustomerId: 'cus_a' });
    await db.doc('subscriptions/sub_a').set({ workspaceId: 'alice' });
    await db.doc('subscriptions/sub_b').set({ workspaceId: 'bob' });

    expect(await repo.stripeCustomerId('alice')).toBe('cus_a');
    await repo.deleteWorkspaceData('alice');

    expect(await exists('links/alice-1')).toBe(false);
    expect(await exists('links/alice-2')).toBe(false);
    expect(await count('links/alice-1/daily')).toBe(0);
    expect(await count('links/alice-1/clicks')).toBe(0);
    expect(await exists('workspaces/alice')).toBe(false);
    expect(await exists('subscriptions/sub_a')).toBe(false);
    // Codes stay retired, without anything tying them to the account.
    const retired = await db.doc('retiredCodes/alice-1').get();
    expect(retired.exists).toBe(true);
    expect(retired.get('workspaceId')).toBeUndefined();
    await expect(link('alice-1', 'bob', 'bob')).rejects.toThrow(/taken/);
    // Someone else's data is untouched.
    expect(await exists('links/bob-1')).toBe(true);
    expect(await exists('workspaces/bob')).toBe(true);
    expect(await exists('subscriptions/sub_b')).toBe(true);

    // Idempotent.
    await repo.deleteWorkspaceData('alice');
  });

  it('pages through more links than one query returns', async () => {
    // Written directly (a batch), so the spec stays fast: 205 > PAGE (200).
    const batch = db.batch();
    for (let i = 0; i < 205; i++) {
      batch.set(db.doc(`links/bulk-${i}`), {
        workspaceId: 'alice',
        targetUrl: 'https://example.com/',
        createdAt: new Date(),
      });
    }
    batch.set(db.doc('links/bulk-0/daily/2026-06-01'), { count: 1 });
    await batch.commit();

    await repo.deleteWorkspaceData('alice');

    const left = await db
      .collection('links')
      .where('workspaceId', '==', 'alice')
      .count()
      .get();
    expect(left.data().count).toBe(0);
    expect(await count('links/bulk-0/daily')).toBe(0);
    expect(await exists('retiredCodes/bulk-204')).toBe(true);
  }, 30_000);

  it('lists memberships, including a team whose doc is already gone', async () => {
    const acme = await teams.createTeam({ uid: 'alice', email: null }, 'Acme');
    const gone = await teams.createTeam({ uid: 'alice', email: null }, 'Gone');
    await db.doc(`workspaces/${gone.id}`).delete();

    const memberships = await repo.listMemberships('alice');

    expect(
      memberships.sort((a, b) => a.teamName.localeCompare(b.teamName)),
    ).toEqual([
      {
        teamId: acme.id,
        role: 'owner',
        teamExists: true,
        teamName: 'Acme',
        memberCount: 1,
      },
      expect.objectContaining({ teamId: gone.id, teamExists: false }),
    ]);
    expect(await repo.listMemberships('nobody')).toEqual([]);
  });

  it('locks a team the owner is alone in; refuses one with members or another owner', async () => {
    const solo = await teams.createTeam({ uid: 'alice', email: null }, 'Solo');
    const busy = await teams.createTeam({ uid: 'alice', email: null }, 'Busy');
    await db.doc(`workspaces/${busy.id}`).update({ memberCount: 2 });
    const now = new Date('2026-06-01T12:00:00Z');

    await repo.lockOwnedTeam(solo.id, 'alice', now);
    await repo.lockOwnedTeam(solo.id, 'alice', now); // a retry
    expect(
      (await db.doc(`workspaces/${solo.id}`).get()).get('deletingAt')?.toDate(),
    ).toEqual(now);

    await expect(
      repo.lockOwnedTeam(busy.id, 'alice', now),
    ).rejects.toBeInstanceOf(TeamHasMembersError);
    await expect(
      repo.lockOwnedTeam(solo.id, 'bob', now),
    ).rejects.toBeInstanceOf(TeamNotOwnedError);
    expect(
      (await db.doc(`workspaces/${busy.id}`).get()).get('deletingAt'),
    ).toBeUndefined();
    // Already gone: nothing to lock.
    await repo.lockOwnedTeam('gone', 'alice', now);
  });

  it('deletes the team doc first (invites stop working), then its data in the sweep', async () => {
    const team = await teams.createTeam({ uid: 'alice', email: null }, 'Solo');
    await link('team-1', team.id, null);
    await db
      .doc(`workspaces/${team.id}/invites/i1`)
      .set({ email: 'x@example.com', status: 'pending' });

    await repo.deleteOwnedTeamDoc(team.id, 'alice');
    expect(await exists(`workspaces/${team.id}`)).toBe(false);
    // Data stays until the sweep, which a retry also runs.
    expect(await exists('links/team-1')).toBe(true);
    await repo.deleteOwnedTeamDoc(team.id, 'alice'); // already gone: no-op

    await repo.deleteWorkspaceData(team.id);
    expect(await count(`workspaces/${team.id}/members`)).toBe(0);
    expect(await count(`workspaces/${team.id}/invites`)).toBe(0);
    expect(await exists('links/team-1')).toBe(false);
    expect(await repo.listMemberships('alice')).toEqual([]);
  });

  it('locks the personal workspace, creating its doc if needed', async () => {
    const now = new Date('2026-06-01T12:00:00Z');
    await repo.lockPersonalWorkspace('alice', now);
    const created = await db.doc('workspaces/alice').get();
    expect(created.get('type')).toBe('personal');
    expect(created.get('ownerUid')).toBe('alice');
    expect(created.get('deletingAt')?.toDate()).toEqual(now);

    await db.doc('workspaces/alice').update({ stripeCustomerId: 'cus_1' });
    const later = new Date('2026-06-01T12:05:00Z');
    await repo.lockPersonalWorkspace('alice', later);
    const updated = await db.doc('workspaces/alice').get();
    expect(updated.get('deletingAt')?.toDate()).toEqual(later);
    expect(updated.get('stripeCustomerId')).toBe('cus_1');
  });

  it('refuses to delete a team that has other members (re-checked in the transaction)', async () => {
    const team = await teams.createTeam({ uid: 'alice', email: null }, 'Busy');
    await db.doc(`workspaces/${team.id}`).update({ memberCount: 2 });

    await expect(
      repo.deleteOwnedTeamDoc(team.id, 'alice'),
    ).rejects.toBeInstanceOf(TeamHasMembersError);
    await expect(
      repo.deleteOwnedTeamDoc(team.id, 'bob'),
    ).rejects.toBeInstanceOf(TeamNotOwnedError);
    expect(await exists(`workspaces/${team.id}`)).toBe(true);
  });

  it('leaves a team once: membership removed, seat count decremented, sent invites revoked', async () => {
    const team = await teams.createTeam({ uid: 'bob', email: null }, 'Acme');
    await db.doc(`workspaces/${team.id}/members/alice`).set({
      uid: 'alice',
      role: 'admin',
    });
    await db.doc(`workspaces/${team.id}`).update({ memberCount: 2 });
    const invites = db.collection(`workspaces/${team.id}/invites`);
    await invites.doc('mine').set({ invitedBy: 'alice', status: 'pending' });
    await invites.doc('used').set({ invitedBy: 'alice', status: 'accepted' });
    await invites.doc('bobs').set({ invitedBy: 'bob', status: 'pending' });

    await repo.leaveTeam(team.id, 'alice');
    await repo.leaveTeam(team.id, 'alice');

    const status = async (id: string) =>
      (await invites.doc(id).get()).get('status');
    expect(await status('mine')).toBe('revoked');
    expect(await status('used')).toBe('accepted');
    expect(await status('bobs')).toBe('pending');

    expect(await exists(`workspaces/${team.id}/members/alice`)).toBe(false);
    expect(
      (await db.doc(`workspaces/${team.id}`).get()).get('memberCount'),
    ).toBe(1);
  });

  it('mirrors profile fields onto users/{uid} and deletes it', async () => {
    // No profile yet: nothing to mirror, no error.
    await repo.updateProfile('alice', { displayName: 'Ada' });
    expect(await exists('users/alice')).toBe(false);

    await db
      .doc('users/alice')
      .set({ displayName: null, photoURL: 'https://a', role: 'user' });
    await repo.updateProfile('alice', {
      displayName: 'Ada',
      photoURL: undefined,
    });
    expect((await db.doc('users/alice').get()).data()).toEqual({
      displayName: 'Ada',
      photoURL: 'https://a',
      role: 'user',
    });

    await repo.deleteProfile('alice');
    await repo.deleteProfile('alice');
    expect(await exists('users/alice')).toBe(false);
  });
});
