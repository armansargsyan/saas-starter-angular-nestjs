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
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type {
  CreateInviteResponse,
  Team,
  TeamInviteListResponse,
  TeamListResponse,
  TeamMemberListResponse,
} from '@saas-starter/shared';
import { configureApp } from '../app/configure-app';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { Clock } from '../common/clock';
import { AppConfigService } from '../config/app-config.service';
import { IdentityProvider } from '../firebase/identity.provider';
import { WorkspacesRepository } from '../workspaces/workspaces.repository';
import { FakeTeamsRepository } from './fake-teams.repository';
import { TeamsModule } from './teams.module';
import { TeamsRepository } from './teams.repository';

// Token "<uid>" signs in as <uid>@example.com (verified); "<uid>:unverified" isn't.
const identity = {
  verifyIdToken: vi.fn(async (token: string) => {
    const [uid, flag] = token.split(':');
    return {
      uid,
      email: `${uid}@example.com`,
      emailVerified: flag !== 'unverified',
      issuedAt: new Date(),
    };
  }),
  getUser: vi.fn(),
};

@Global()
@Module({
  providers: [
    { provide: IdentityProvider, useValue: identity },
    {
      provide: AppConfigService,
      useValue: { appUrl: 'https://app.example.com' },
    },
  ],
  exports: [IdentityProvider, AppConfigService],
})
class FakeGlobalsModule {}

const TEAM_PLAN = {
  id: 'team',
  status: 'active',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
} as const;

describe('teams api', () => {
  let app: INestApplication;
  let baseUrl: string;
  const repo = new FakeTeamsRepository();
  let now = new Date('2026-06-01T12:00:00Z');
  let throttles = new ThrottlerStorageService();

  const call = async <T = unknown>(
    method: string,
    path: string,
    as?: string,
    body?: unknown,
  ) => {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: {
        ...(as && { Authorization: `Bearer ${as}` }),
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };

  /** alice owns a team on the Team plan; bob is admin, carol member. */
  async function teamWithMembers() {
    const { body: team } = await call<Team>('POST', '/teams', 'alice', {
      name: 'Acme',
    });
    repo.setPlan(team.id, TEAM_PLAN);
    for (const [uid, role] of [
      ['bob', 'admin'],
      ['carol', 'member'],
    ] as const) {
      const { body } = await call<CreateInviteResponse>(
        'POST',
        `/teams/${team.id}/invites`,
        'alice',
        {
          email: `${uid}@example.com`,
          role,
        },
      );
      await call('POST', '/invites/accept', uid, { token: tokenOf(body) });
    }
    return team.id;
  }

  const tokenOf = (res: CreateInviteResponse) =>
    decodeURIComponent(new URL(res.acceptUrl).hash.replace(/^#token=/, ''));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeGlobalsModule, TeamsModule],
      providers: [{ provide: APP_GUARD, useClass: FirebaseAuthGuard }],
    })
      .overrideProvider(TeamsRepository)
      .useValue(repo)
      .overrideProvider(WorkspacesRepository)
      .useValue({
        getMemberRole: async (ws: string, uid: string) => repo.roleOf(ws, uid),
        isMember: async (ws: string, uid: string) =>
          repo.roleOf(ws, uid) !== null,
      })
      .overrideProvider(Clock)
      .useValue({ now: () => now })
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: (
          ...args: Parameters<ThrottlerStorageService['increment']>
        ) => throttles.increment(...args),
      })
      .compile();
    repo.now = () => now;
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app, { trustProxyHops: 1 });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    throttles.onApplicationShutdown();
    await app.close();
  });

  beforeEach(() => {
    repo.teams.clear();
    repo.deleting.clear();
    repo.members.clear();
    repo.invites.clear();
    now = new Date('2026-06-01T12:00:00Z');
    throttles.onApplicationShutdown();
    throttles = new ThrottlerStorageService();
  });

  describe('teams', () => {
    it('creates a team with the creator as owner, listed under their teams', async () => {
      const created = await call<Team>('POST', '/teams', 'alice', {
        name: ' Acme ',
      });

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        name: 'Acme',
        role: 'owner',
        plan: 'free',
        memberCount: 1,
      });
      const list = await call<TeamListResponse>('GET', '/teams', 'alice');
      expect(list.body.items.map((t) => t.id)).toEqual([created.body.id]);
      expect(
        (await call<TeamListResponse>('GET', '/teams', 'bob')).body.items,
      ).toEqual([]);
    });

    it('hides a team from non-members (404) and validates ids', async () => {
      const id = await teamWithMembers();
      for (const path of [
        `/teams/${id}`,
        `/teams/${id}/members`,
        `/teams/${id}/invites`,
      ]) {
        expect((await call('GET', path, 'mallory')).status).toBe(404);
      }
      expect((await call('GET', '/teams/a%2Fb', 'alice')).status).toBe(400);
      // A personal workspace isn't a team.
      expect((await call('GET', '/teams/alice', 'alice')).status).toBe(404);
    });

    it('lets owner and admin rename, not a member', async () => {
      const id = await teamWithMembers();
      expect(
        (await call('PATCH', `/teams/${id}`, 'bob', { name: 'New' })).status,
      ).toBe(200);
      expect(
        (await call('PATCH', `/teams/${id}`, 'carol', { name: 'Nope' })).status,
      ).toBe(403);
      expect(repo.teams.get(id)?.name).toBe('New');
    });
  });

  describe('invites', () => {
    it('invites by email with a link that reveals the token only to the inviter', async () => {
      const { body: team } = await call<Team>('POST', '/teams', 'alice', {
        name: 'Acme',
      });
      repo.setPlan(team.id, TEAM_PLAN);

      const res = await call<CreateInviteResponse>(
        'POST',
        `/teams/${team.id}/invites`,
        'alice',
        {
          email: 'Bob@Example.com',
        },
      );

      expect(res.status).toBe(201);
      expect(res.body.invite).toMatchObject({
        email: 'bob@example.com',
        role: 'member',
        status: 'pending',
      });
      expect(res.body.invite.expiresAt).toBe('2026-06-08T12:00:00.000Z');
      expect(res.body.acceptUrl).toMatch(
        /^https:\/\/app\.example\.com\/invite#token=/,
      );
      const listed = await call<TeamInviteListResponse>(
        'GET',
        `/teams/${team.id}/invites`,
        'alice',
      );
      expect(JSON.stringify(listed.body)).not.toContain(
        tokenOf(res.body).split('.')[2],
      );
      expect(JSON.stringify(listed.body)).not.toContain('secretHash');
    });

    it('needs the Team plan to add members (403 plan_limit_reached)', async () => {
      const { body: team } = await call<Team>('POST', '/teams', 'alice', {
        name: 'Acme',
      });
      const res = await call('POST', `/teams/${team.id}/invites`, 'alice', {
        email: 'bob@example.com',
      });
      expect(res).toMatchObject({
        status: 403,
        body: { code: 'plan_limit_reached', resource: 'members', limit: 1 },
      });
    });

    it('accepts: joins with the invited role, previews first', async () => {
      const { body: team } = await call<Team>('POST', '/teams', 'alice', {
        name: 'Acme',
      });
      repo.setPlan(team.id, TEAM_PLAN);
      const { body } = await call<CreateInviteResponse>(
        'POST',
        `/teams/${team.id}/invites`,
        'alice',
        {
          email: 'bob@example.com',
          role: 'admin',
        },
      );
      const token = tokenOf(body);

      const preview = await call('POST', '/invites/preview', 'bob', { token });
      expect(preview.body).toMatchObject({
        teamName: 'Acme',
        role: 'admin',
        email: 'bob@example.com',
      });

      const accepted = await call<Team>('POST', '/invites/accept', 'bob', {
        token,
      });
      expect(accepted).toMatchObject({
        status: 200,
        body: { id: team.id, role: 'admin', memberCount: 2 },
      });
      expect(
        (await call('POST', '/invites/accept', 'bob', { token })).status,
      ).toBe(404); // used
    });

    it('refuses the wrong person, an unverified email, a forged secret and expired invites', async () => {
      const { body: team } = await call<Team>('POST', '/teams', 'alice', {
        name: 'Acme',
      });
      repo.setPlan(team.id, TEAM_PLAN);
      const { body } = await call<CreateInviteResponse>(
        'POST',
        `/teams/${team.id}/invites`,
        'alice',
        {
          email: 'bob@example.com',
        },
      );
      const token = tokenOf(body);
      const forged = token.replace(/\.[^.]+$/, `.${'A'.repeat(43)}`);

      expect(
        (await call('POST', '/invites/accept', 'mallory', { token })).body,
      ).toMatchObject({
        code: 'invite_email_mismatch',
      });
      expect(
        (await call('POST', '/invites/accept', 'bob:unverified', { token }))
          .body,
      ).toMatchObject({
        code: 'email_not_verified',
      });
      expect(
        (await call('POST', '/invites/accept', 'bob', { token: forged })).body,
      ).toMatchObject({
        code: 'invite_invalid',
      });
      expect(
        (await call('POST', '/invites/preview', 'bob', { token: forged }))
          .status,
      ).toBe(404);
      expect(
        (await call('POST', '/invites/accept', 'bob', { token: 'garbage' }))
          .status,
      ).toBe(400);

      now = new Date('2026-06-08T12:00:01Z');
      expect(
        await call('POST', '/invites/accept', 'bob', { token }),
      ).toMatchObject({
        status: 410,
        body: { code: 'invite_expired' },
      });
    });

    it('declines; a revoked or superseded invite no longer works', async () => {
      const { body: team } = await call<Team>('POST', '/teams', 'alice', {
        name: 'Acme',
      });
      repo.setPlan(team.id, TEAM_PLAN);
      const invite = (email: string) =>
        call<CreateInviteResponse>(
          'POST',
          `/teams/${team.id}/invites`,
          'alice',
          { email },
        );

      const declined = tokenOf((await invite('bob@example.com')).body);
      expect(
        (await call('POST', '/invites/decline', 'bob', { token: declined }))
          .status,
      ).toBe(204);
      expect(
        (await call('POST', '/invites/accept', 'bob', { token: declined }))
          .status,
      ).toBe(404);

      const first = await invite('carol@example.com');
      const second = await invite('carol@example.com'); // supersedes the first
      expect(
        (
          await call('POST', '/invites/accept', 'carol', {
            token: tokenOf(first.body),
          })
        ).status,
      ).toBe(404);

      expect(
        (
          await call(
            'DELETE',
            `/teams/${team.id}/invites/${second.body.invite.id}`,
            'alice',
          )
        ).status,
      ).toBe(204);
      expect(
        (
          await call('POST', '/invites/accept', 'carol', {
            token: tokenOf(second.body),
          })
        ).status,
      ).toBe(404);
    });

    it('refuses joins and new invites while the owner deletes their account (409 team_deleting)', async () => {
      const { body: team } = await call<Team>('POST', '/teams', 'alice', {
        name: 'Acme',
      });
      repo.setPlan(team.id, TEAM_PLAN);
      const { body } = await call<CreateInviteResponse>(
        'POST',
        `/teams/${team.id}/invites`,
        'alice',
        { email: 'bob@example.com', role: 'member' },
      );
      repo.deleting.add(team.id);

      const accepted = await call('POST', '/invites/accept', 'bob', {
        token: tokenOf(body),
      });
      expect(accepted).toMatchObject({
        status: 409,
        body: { code: 'team_deleting' },
      });
      const invited = await call('POST', `/teams/${team.id}/invites`, 'alice', {
        email: 'carol@example.com',
        role: 'member',
      });
      expect(invited).toMatchObject({
        status: 409,
        body: { code: 'team_deleting' },
      });
      expect(repo.roleOf(team.id, 'bob')).toBeNull();
    });

    it('respects the seat limit at accept time', async () => {
      const { body: team } = await call<Team>('POST', '/teams', 'alice', {
        name: 'Acme',
      });
      repo.setPlan(team.id, TEAM_PLAN);
      const tokens: string[] = [];
      for (let i = 0; i < 10; i++) {
        const { body } = await call<CreateInviteResponse>(
          'POST',
          `/teams/${team.id}/invites`,
          'alice',
          {
            email: `u${i}@example.com`,
          },
        );
        tokens.push(tokenOf(body));
      }
      for (let i = 0; i < 9; i++) {
        expect(
          (await call('POST', '/invites/accept', `u${i}`, { token: tokens[i] }))
            .status,
        ).toBe(200);
      }

      const tenth = await call('POST', '/invites/accept', 'u9', {
        token: tokens[9],
      });

      expect(tenth).toMatchObject({
        status: 403,
        body: { code: 'plan_limit_reached', limit: 10 },
      });
      expect(repo.teams.get(team.id)?.memberCount).toBe(10);
    });

    it('rate limits the invite endpoints per user', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 21; i++) {
        statuses.push(
          (
            await call('POST', '/invites/accept', 'eve', {
              token: `t.i.${'A'.repeat(43)}`,
            })
          ).status,
        );
      }
      expect(statuses.at(-1)).toBe(429);
    });
  });

  describe('permissions', () => {
    it('owner: everything; admin: invite members, not admins; member: neither', async () => {
      const id = await teamWithMembers();
      const invite = (as: string, role: string) =>
        call('POST', `/teams/${id}/invites`, as, {
          email: `x-${as}-${role}@example.com`,
          role,
        });

      expect((await invite('alice', 'admin')).status).toBe(201);
      expect((await invite('bob', 'member')).status).toBe(201);
      expect((await invite('bob', 'admin')).status).toBe(403);
      expect((await invite('carol', 'member')).status).toBe(403);
      expect((await call('GET', `/teams/${id}/invites`, 'carol')).status).toBe(
        403,
      );
      expect(
        (
          await call<TeamMemberListResponse>(
            'GET',
            `/teams/${id}/members`,
            'carol',
          )
        ).body.items,
      ).toHaveLength(3);
    });

    it('only the owner changes roles, and never their own', async () => {
      const id = await teamWithMembers();
      expect(
        (
          await call('PATCH', `/teams/${id}/members/carol`, 'bob', {
            role: 'admin',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call('PATCH', `/teams/${id}/members/carol`, 'alice', {
            role: 'admin',
          })
        ).status,
      ).toBe(204);
      expect(
        (
          await call('PATCH', `/teams/${id}/members/alice`, 'alice', {
            role: 'member',
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await call('PATCH', `/teams/${id}/members/bob`, 'alice', {
            role: 'owner',
          })
        ).status,
      ).toBe(400);
      expect(repo.roleOf(id, 'carol')).toBe('admin');
    });

    it('admins remove members but not admins or the owner; members can only leave', async () => {
      const id = await teamWithMembers();
      expect(
        (await call('DELETE', `/teams/${id}/members/alice`, 'bob')).status,
      ).toBe(403);
      expect(
        (await call('DELETE', `/teams/${id}/members/bob`, 'carol')).status,
      ).toBe(403);
      expect(
        (await call('DELETE', `/teams/${id}/members/carol`, 'bob')).status,
      ).toBe(204);
      expect(repo.teams.get(id)?.memberCount).toBe(2);
      // Lost access right away.
      expect((await call('GET', `/teams/${id}`, 'carol')).status).toBe(404);
    });

    it('an admin cannot remove another admin; the owner can', async () => {
      const id = await teamWithMembers();
      await call('PATCH', `/teams/${id}/members/carol`, 'alice', {
        role: 'admin',
      });
      expect(
        (await call('DELETE', `/teams/${id}/members/carol`, 'bob')).status,
      ).toBe(403);
      expect(
        (await call('DELETE', `/teams/${id}/members/carol`, 'alice')).status,
      ).toBe(204);
    });

    it('members can leave; the owner cannot', async () => {
      const id = await teamWithMembers();
      expect(
        (await call('DELETE', `/teams/${id}/members/carol`, 'carol')).status,
      ).toBe(204);
      expect(
        (await call('DELETE', `/teams/${id}/members/alice`, 'alice')).status,
      ).toBe(403);
    });
  });
});
