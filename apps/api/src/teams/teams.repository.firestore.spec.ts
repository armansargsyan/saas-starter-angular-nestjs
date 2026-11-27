/**
 * FirestoreTeamsRepository against the Firestore emulator. Skipped unless
 * FIRESTORE_EMULATOR_HOST is set; run with `npx nx test-firestore api`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { FirestoreWorkspacesRepository } from '../workspaces/workspaces.repository';
import {
  createInviteToken,
  hashSecret,
  parseInviteToken,
} from './invite-token';
import { FirestoreTeamsRepository } from './teams.repository';

const host = process.env['FIRESTORE_EMULATOR_HOST'];
const PROJECT = 'demo-links-test';
const DAY_MS = 86_400_000;
const OWNER = { uid: 'alice', allowed: () => true };
const NOW = () => new Date();

describe.skipIf(!host)('FirestoreTeamsRepository (emulator)', () => {
  let app: App;
  let db: Firestore;
  let repo: FirestoreTeamsRepository;

  beforeAll(() => {
    app = initializeApp({ projectId: PROJECT }, 'teams-repo-spec');
    db = getFirestore(app);
    repo = new FirestoreTeamsRepository(db);
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

  const onTeamPlan = (teamId: string) =>
    db.doc(`workspaces/${teamId}`).update({
      plan: {
        id: 'team',
        status: 'active',
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      },
    });

  async function invite(teamId: string, email: string, expiresInMs = DAY_MS) {
    const inviteId = repo.newInviteId(teamId);
    const { token, secretHash } = createInviteToken(teamId, inviteId);
    await repo.createInvite(
      teamId,
      inviteId,
      {
        email,
        role: 'member',
        invitedBy: 'alice',
        secretHash,
        expiresAt: new Date(Date.now() + expiresInMs),
      },
      OWNER,
    );
    const secret = parseInviteToken(token)?.secret ?? '';
    return { inviteId, secretHash: hashSecret(secret) };
  }

  it('creates a team with its owner and lists it for members (collection group)', async () => {
    const team = await repo.createTeam(
      { uid: 'alice', email: 'alice@example.com' },
      'Acme',
    );

    expect(team).toMatchObject({
      name: 'Acme',
      ownerUid: 'alice',
      memberCount: 1,
      plan: null,
    });
    expect(await repo.listTeamsForUser('alice')).toEqual([
      { team: expect.objectContaining({ id: team.id }), role: 'owner' },
    ]);
    expect(await repo.listTeamsForUser('bob')).toEqual([]);
    expect(
      await new FirestoreWorkspacesRepository(db).getMemberRole(
        team.id,
        'alice',
      ),
    ).toBe('owner');
  });

  it('accepts an invite: member doc, memberCount, invite status', async () => {
    const team = await repo.createTeam({ uid: 'alice', email: null }, 'Acme');
    await onTeamPlan(team.id);
    const { inviteId, secretHash } = await invite(team.id, 'bob@example.com');

    expect(
      await repo.acceptInvite(
        team.id,
        inviteId,
        secretHash,
        {
          uid: 'bob',
          email: 'BOB@example.com',
        },
        NOW(),
      ),
    ).toEqual({ ok: true, teamId: team.id });

    expect((await repo.getTeam(team.id))?.memberCount).toBe(2);
    expect((await repo.getInvite(team.id, inviteId))?.status).toBe('accepted');
    expect(await repo.listTeamsForUser('bob')).toHaveLength(1);
    expect(
      await repo.acceptInvite(
        team.id,
        inviteId,
        secretHash,
        {
          uid: 'bob',
          email: 'bob@example.com',
        },
        NOW(),
      ),
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('checks the secret, expiry, email and existing membership', async () => {
    const team = await repo.createTeam({ uid: 'alice', email: null }, 'Acme');
    await onTeamPlan(team.id);
    const bob = { uid: 'bob', email: 'bob@example.com' };
    const { inviteId, secretHash } = await invite(team.id, 'bob@example.com');
    const expired = await invite(team.id, 'old@example.com', -1);

    expect(
      await repo.acceptInvite(
        team.id,
        inviteId,
        hashSecret('wrong'),
        bob,
        NOW(),
      ),
    ).toMatchObject({ reason: 'invalid' });
    expect(
      await repo.acceptInvite(
        team.id,
        inviteId,
        secretHash,
        {
          uid: 'eve',
          email: 'eve@example.com',
        },
        NOW(),
      ),
    ).toMatchObject({ reason: 'email_mismatch' });
    expect(
      await repo.acceptInvite(
        team.id,
        expired.inviteId,
        expired.secretHash,
        {
          uid: 'o',
          email: 'old@example.com',
        },
        NOW(),
      ),
    ).toMatchObject({ reason: 'expired' });

    const again = await invite(team.id, 'alice@example.com');
    expect(
      await repo.acceptInvite(
        team.id,
        again.inviteId,
        again.secretHash,
        {
          uid: 'alice',
          email: 'alice@example.com',
        },
        NOW(),
      ),
    ).toMatchObject({ reason: 'already_member' });
  });

  it('cannot be pushed past the seat limit by concurrent accepts', async () => {
    const team = await repo.createTeam({ uid: 'alice', email: null }, 'Acme');
    await onTeamPlan(team.id);
    await db.doc(`workspaces/${team.id}`).update({ memberCount: 8 }); // 2 seats left
    const invites = await Promise.all(
      [0, 1, 2, 3].map(async (i) => ({
        i,
        ...(await invite(team.id, `u${i}@example.com`)),
      })),
    );

    const results = await Promise.all(
      invites.map(({ i, inviteId, secretHash }) =>
        repo.acceptInvite(
          team.id,
          inviteId,
          secretHash,
          {
            uid: `u${i}`,
            email: `u${i}@example.com`,
          },
          NOW(),
        ),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, reason: 'seat_limit', plan: 'team', limit: 10 },
      { ok: false, reason: 'seat_limit', plan: 'team', limit: 10 },
    ]);
    expect((await repo.getTeam(team.id))?.memberCount).toBe(10);
  }, 60_000);

  it('needs a paid Team plan for a second seat', async () => {
    const team = await repo.createTeam({ uid: 'alice', email: null }, 'Acme');
    const { inviteId, secretHash } = await invite(team.id, 'bob@example.com');
    expect(
      await repo.acceptInvite(
        team.id,
        inviteId,
        secretHash,
        {
          uid: 'bob',
          email: 'bob@example.com',
        },
        NOW(),
      ),
    ).toEqual({ ok: false, reason: 'seat_limit', plan: 'free', limit: 1 });
  });

  it('declines, revokes, and supersedes earlier pending invites to the same email', async () => {
    const team = await repo.createTeam({ uid: 'alice', email: null }, 'Acme');
    const bob = { uid: 'bob', email: 'bob@example.com' };
    const first = await invite(team.id, 'bob@example.com');
    const second = await invite(team.id, 'bob@example.com');

    expect((await repo.getInvite(team.id, first.inviteId))?.status).toBe(
      'revoked',
    );
    expect(
      await repo.declineInvite(
        team.id,
        second.inviteId,
        second.secretHash,
        bob,
        NOW(),
      ),
    ).toMatchObject({ ok: true });
    expect((await repo.getInvite(team.id, second.inviteId))?.status).toBe(
      'declined',
    );

    const third = await invite(team.id, 'carol@example.com');
    expect(await repo.revokeInvite(team.id, third.inviteId, OWNER)).toBe(true);
    expect(await repo.revokeInvite(team.id, third.inviteId, OWNER)).toBe(false);
    const listed = await repo.listInvites(team.id);
    expect(listed).toHaveLength(3);
    expect(JSON.stringify(listed)).not.toContain('secretHash');
  });

  it('changes roles and removes members, never the owner', async () => {
    const team = await repo.createTeam({ uid: 'alice', email: null }, 'Acme');
    await onTeamPlan(team.id);
    const { inviteId, secretHash } = await invite(team.id, 'bob@example.com');
    await repo.acceptInvite(
      team.id,
      inviteId,
      secretHash,
      {
        uid: 'bob',
        email: 'bob@example.com',
      },
      NOW(),
    );

    expect(await repo.setMemberRole(team.id, 'bob', 'admin')).toBe(true);
    expect(await repo.setMemberRole(team.id, 'alice', 'member')).toBe(false);
    expect(
      await repo
        .removeMember(team.id, 'alice', 'alice', () => true)
        .catch((e) => e.constructor.name),
    ).toBe('ActorNotAllowedError');
    expect(
      await repo
        .removeMember(team.id, 'bob', 'alice', (_a, role) => role === 'member')
        .catch((e) => e.constructor.name),
    ).toBe('ActorNotAllowedError');
    expect(await repo.removeMember(team.id, 'bob', 'alice', () => true)).toBe(
      true,
    );
    expect((await repo.getTeam(team.id))?.memberCount).toBe(1);
    expect(
      await new FirestoreWorkspacesRepository(db).isMember(team.id, 'bob'),
    ).toBe(false);
  });
});

describe.skipIf(!host)(
  'FirestoreTeamsRepository actor checks (emulator)',
  () => {
    let app: App;
    let db: Firestore;
    let repo: FirestoreTeamsRepository;

    beforeAll(() => {
      app = initializeApp({ projectId: PROJECT }, 'teams-actor-spec');
      db = getFirestore(app);
      repo = new FirestoreTeamsRepository(db);
    });

    afterAll(async () => {
      await deleteApp(app);
    });

    it('refuses writes by someone who was demoted or removed a moment ago', async () => {
      const team = await repo.createTeam({ uid: 'alice', email: null }, 'Acme');
      await db
        .doc(`workspaces/${team.id}/members/bob`)
        .set({ uid: 'bob', role: 'member' });
      const asAdmin = {
        uid: 'bob',
        allowed: (role: string) => role === 'owner' || role === 'admin',
      };
      const inviteId = repo.newInviteId(team.id);
      const invite = {
        email: 'x@example.com',
        role: 'member' as const,
        invitedBy: 'bob',
        secretHash: hashSecret('s'),
        expiresAt: new Date(Date.now() + DAY_MS),
      };

      // bob's role is "member" now (demoted after the service-level check).
      await expect(
        repo.createInvite(team.id, inviteId, invite, asAdmin),
      ).rejects.toThrow('Not allowed');
      await repo.createInvite(team.id, inviteId, invite, OWNER);
      await expect(
        repo.revokeInvite(team.id, inviteId, asAdmin),
      ).rejects.toThrow('Not allowed');

      await expect(
        repo.renameTeam(team.id, 'Hijacked', asAdmin),
      ).rejects.toThrow('Not allowed');
      await repo.renameTeam(team.id, 'Renamed', OWNER);
      expect((await repo.getTeam(team.id))?.name).toBe('Renamed');

      // Removed entirely: no member doc.
      await db.doc(`workspaces/${team.id}/members/bob`).delete();
      await expect(
        repo.removeMember(team.id, 'alice', 'bob', () => true),
      ).rejects.toThrow('Not allowed');
    });
  },
);
