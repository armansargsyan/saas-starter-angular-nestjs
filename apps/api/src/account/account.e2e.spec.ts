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
  AccountDeletionBlockedBody,
  ProfileResponse,
} from '@saas-starter/shared';
import { configureApp } from '../app/configure-app';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { BillingProvider } from '../billing/billing.provider';
import { BillingRepository } from '../billing/billing.repository';
import { STRIPE_CLIENT } from '../billing/stripe.client';
import { AppConfigService } from '../config/app-config.service';
import { IdentityProvider } from '../firebase/identity.provider';
import { WorkspacesRepository } from '../workspaces/workspaces.repository';
import { AccountModule } from './account.module';
import { AccountRepository, type Membership } from './account.repository';

/** In-memory AccountRepository: what's left of each account's data. */
class FakeAccountRepository extends AccountRepository {
  memberships = new Map<string, Membership[]>();
  workspaces = new Set<string>();
  customers = new Map<string, string>();
  profiles = new Map<string, Record<string, unknown>>();

  async listMemberships(uid: string) {
    return this.memberships.get(uid) ?? [];
  }
  locked = new Set<string>();
  async lockOwnedTeam(teamId: string) {
    this.locked.add(teamId);
  }
  async stripeCustomerId(workspaceId: string) {
    return this.customers.get(workspaceId) ?? null;
  }
  async lockPersonalWorkspace(uid: string) {
    this.locked.add(uid);
  }
  async deleteOwnedTeamDoc(teamId: string) {
    this.workspaces.delete(teamId);
  }
  async deleteWorkspaceData(workspaceId: string) {
    this.workspaces.delete(workspaceId);
  }
  async leaveTeam(teamId: string, uid: string) {
    this.memberships.set(
      uid,
      (this.memberships.get(uid) ?? []).filter((m) => m.teamId !== teamId),
    );
  }
  async updateProfile(uid: string, profile: Record<string, unknown>) {
    const existing = this.profiles.get(uid);
    if (existing) Object.assign(existing, profile);
  }
  async deleteProfile(uid: string) {
    this.profiles.delete(uid);
  }
}

// Token "<uid>" signs in as <uid> (just now); "<uid>:imp" is an admin
// impersonating <uid>; "<uid>:old" signed in an hour ago.
const HOUR_AGO = () => new Date(Date.now() - 3_600_000);
const identity = {
  verifyIdToken: vi.fn(async (token: string) => {
    const [uid, flag] = token.split(':');
    return {
      uid,
      email: `${uid}@example.com`,
      emailVerified: true,
      issuedAt: new Date(),
      authTime: flag === 'old' ? HOUR_AGO() : new Date(),
      impersonatedBy: flag === 'imp' ? 'admin-1' : null,
      impersonatedAt: flag === 'imp' ? new Date() : null,
    };
  }),
  getUser: vi.fn(),
  updateProfile: vi.fn(),
  deleteUser: vi.fn(),
};

const billing = {
  cancelAllSubscriptions: vi.fn(),
  expireOpenCheckoutSessions: vi.fn(),
};

@Global()
@Module({
  providers: [
    { provide: IdentityProvider, useValue: identity },
    { provide: AppConfigService, useValue: {} },
  ],
  exports: [IdentityProvider, AppConfigService],
})
class FakeGlobalsModule {}

describe('account api', () => {
  let app: INestApplication;
  let baseUrl: string;
  const repo = new FakeAccountRepository();
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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeGlobalsModule, AccountModule],
      providers: [{ provide: APP_GUARD, useClass: FirebaseAuthGuard }],
    })
      .overrideProvider(AccountRepository)
      .useValue(repo)
      .overrideProvider(BillingProvider)
      .useValue(billing)
      // The rest of BillingModule is never reached: no Stripe client, no Firestore.
      .overrideProvider(STRIPE_CLIENT)
      .useValue({})
      .overrideProvider(BillingRepository)
      .useValue({})
      .overrideProvider(WorkspacesRepository)
      .useValue({})
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: (
          ...args: Parameters<ThrottlerStorageService['increment']>
        ) => throttles.increment(...args),
      })
      .compile();
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
    vi.clearAllMocks();
    repo.memberships.clear();
    repo.workspaces = new Set(['alice', 'bob']);
    repo.customers.clear();
    repo.profiles = new Map([
      ['alice', { displayName: null, photoURL: null }],
      ['bob', { displayName: null, photoURL: null }],
    ]);
    identity.getUser.mockImplementation(async (uid: string) => ({
      uid,
      ...repo.profiles.get(uid),
    }));
    billing.cancelAllSubscriptions.mockResolvedValue([]);
    repo.locked.clear();
    throttles.onApplicationShutdown();
    throttles = new ThrottlerStorageService();
  });

  describe('DELETE /api/account', () => {
    it('requires a token', async () => {
      expect((await call('DELETE', '/account')).status).toBe(401);
    });

    it('deletes only the caller’s data and user, and is safe to retry', async () => {
      repo.customers.set('alice', 'cus_alice');

      expect((await call('DELETE', '/account', 'alice')).status).toBe(204);

      expect(billing.cancelAllSubscriptions).toHaveBeenCalledWith('cus_alice');
      expect(identity.deleteUser).toHaveBeenCalledWith('alice');
      expect([...repo.workspaces]).toEqual(['bob']);
      expect([...repo.profiles.keys()]).toEqual(['bob']);

      // A retry (e.g. the response was lost) succeeds too.
      expect((await call('DELETE', '/account', 'alice')).status).toBe(204);
    });

    it('answers 409 owns_team_with_members while a team still has others', async () => {
      repo.memberships.set('alice', [
        {
          teamId: 't1',
          role: 'owner',
          teamExists: true,
          teamName: 'Acme',
          memberCount: 2,
        },
      ]);

      const res = await call<AccountDeletionBlockedBody>(
        'DELETE',
        '/account',
        'alice',
      );

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'owns_team_with_members',
        teams: [{ id: 't1', name: 'Acme' }],
      });
      expect(identity.deleteUser).not.toHaveBeenCalled();
      expect(repo.workspaces.has('alice')).toBe(true);
    });

    it('needs a recent sign-in (403 requires_recent_login)', async () => {
      const res = await call('DELETE', '/account', 'alice:old');
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'requires_recent_login' });
      expect(identity.deleteUser).not.toHaveBeenCalled();
      expect(repo.workspaces.has('alice')).toBe(true);
    });

    it('is read-only under impersonation', async () => {
      const res = await call('DELETE', '/account', 'alice:imp');
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'impersonation_read_only' });
      expect(identity.deleteUser).not.toHaveBeenCalled();
    });

    it('answers 503 without provider details when Stripe is down', async () => {
      repo.customers.set('alice', 'cus_alice');
      billing.cancelAllSubscriptions.mockRejectedValue(
        new Error('stripe internal detail'),
      );

      const res = await call('DELETE', '/account', 'alice');

      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).not.toContain('internal detail');
      expect(repo.workspaces.has('alice')).toBe(true);
    });

    it('is rate limited per user', async () => {
      // Blocked deletions still count, so retries can't hammer the api.
      repo.memberships.set('alice', [
        {
          teamId: 't1',
          role: 'owner',
          teamExists: true,
          teamName: 'Acme',
          memberCount: 2,
        },
      ]);
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        statuses.push((await call('DELETE', '/account', 'alice')).status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 409)).toBe(true);
      expect(statuses[10]).toBe(429);
      // Someone else isn't affected.
      expect((await call('DELETE', '/account', 'bob')).status).toBe(204);
    });
  });

  describe('PATCH /api/account/profile', () => {
    it('updates the name and avatar and returns the stored profile', async () => {
      identity.updateProfile.mockImplementation(
        async (uid: string, fields: Record<string, unknown>) => {
          Object.assign(repo.profiles.get(uid) ?? {}, fields);
        },
      );

      const res = await call<ProfileResponse>(
        'PATCH',
        '/account/profile',
        'alice',
        {
          displayName: ' Ada ',
          photoURL: 'https://example.com/ada.png',
        },
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        displayName: 'Ada',
        photoURL: 'https://example.com/ada.png',
      });
      expect(identity.updateProfile).toHaveBeenCalledWith('alice', {
        displayName: 'Ada',
        photoURL: 'https://example.com/ada.png',
      });
    });

    it.each([
      [{ photoURL: 'http://example.com/a.png' }, 'photoURL'],
      [{ displayName: 'x'.repeat(81) }, 'displayName'],
      [{ uid: 'bob', displayName: 'x' }, ''],
    ])('rejects %j (400)', async (body, path) => {
      const res = await call<{ issues: { path: string }[] }>(
        'PATCH',
        '/account/profile',
        'alice',
        body,
      );
      expect(res.status).toBe(400);
      expect(res.body.issues.map((i) => i.path)).toContain(path);
      expect(identity.updateProfile).not.toHaveBeenCalled();
    });

    it('is read-only under impersonation', async () => {
      const res = await call('PATCH', '/account/profile', 'alice:imp', {
        displayName: 'Hacked',
      });
      expect(res.status).toBe(403);
      expect(identity.updateProfile).not.toHaveBeenCalled();
    });
  });
});
