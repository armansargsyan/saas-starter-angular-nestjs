import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Global, type INestApplication, Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type {
  AdminStatsResponse,
  AdminUserListResponse,
  ImpersonationResponse,
} from '@saas-starter/shared';
import { configureApp } from '../app/configure-app';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Clock } from '../common/clock';
import { IdentityProvider } from '../firebase/identity.provider';
import { AdminModule } from './admin.module';
import { AdminRepository, type AdminUserRecord } from './admin.repository';
import { mrrByCurrency } from './admin.service';
import { AuditLogRepository } from './audit-log.repository';

const NOW = new Date('2026-06-10T12:00:00Z');

// Bearer "<uid>"; uids starting with "admin" carry the admin claim.
const identity = {
  verifyIdToken: vi.fn(async (token: string) => ({
    uid: token,
    emailVerified: true,
    issuedAt: NOW,
    authTime: NOW,
    impersonatedBy: null,
    impersonatedAt: null,
    role: token.startsWith('admin') ? 'admin' : undefined,
  })),
  getUser: vi.fn(),
  setDisabled: vi.fn(),
  revokeSessions: vi.fn(),
  createCustomToken: vi.fn(),
};

@Global()
@Module({
  providers: [{ provide: IdentityProvider, useValue: identity }],
  exports: [IdentityProvider],
})
class FakeIdentityModule {}

const record = (
  uid: string,
  overrides: Partial<AdminUserRecord> = {},
): AdminUserRecord => ({
  uid,
  email: `${uid}@example.com`,
  displayName: null,
  role: 'user',
  status: 'active',
  createdAt: new Date('2026-06-01T00:00:00Z'),
  plan: null,
  linkCount: 3,
  ...overrides,
});

describe('admin api', () => {
  let app: INestApplication;
  let baseUrl: string;
  const repo = {
    listUsers: vi.fn(),
    getUser: vi.fn(),
    setStatus: vi.fn(),
    subscriptions: vi.fn(),
    countSignups: vi.fn(),
  };
  const audit = { begin: vi.fn(), finish: vi.fn() };

  const call = async <T = unknown>(
    method: string,
    path: string,
    as?: string,
  ) => {
    const res = await fetch(`${baseUrl}/api/admin${path}`, {
      method,
      headers: as ? { Authorization: `Bearer ${as}` } : {},
    });
    return { status: res.status, body: (await res.json()) as T };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeIdentityModule, AdminModule],
      providers: [
        { provide: APP_GUARD, useClass: FirebaseAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(AdminRepository)
      .useValue(repo)
      .overrideProvider(AuditLogRepository)
      .useValue(audit)
      .overrideProvider(Clock)
      .useValue({ now: () => NOW })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app, { trustProxyHops: 1 });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    audit.begin.mockResolvedValue('audit-1');
    identity.getUser.mockImplementation(async (uid: string) => ({
      uid,
      email: `${uid}@example.com`,
      displayName: null,
      photoURL: null,
      disabled: false,
      role: uid.startsWith('admin') ? 'admin' : 'user',
    }));
    identity.createCustomToken.mockResolvedValue('custom-token-xyz');
    repo.getUser.mockImplementation(async (uid: string) => record(uid));
  });

  it('is admin-only: 401 without a token, 403 for users, on every route', async () => {
    for (const [method, path] of [
      ['GET', '/users'],
      ['GET', '/users/bob'],
      ['POST', '/users/bob/ban'],
      ['POST', '/users/bob/unban'],
      ['POST', '/users/bob/impersonate'],
      ['GET', '/stats'],
    ]) {
      expect((await call(method, path)).status).toBe(401);
      expect((await call(method, path, 'bob')).status).toBe(403);
    }
    expect(repo.listUsers).not.toHaveBeenCalled();
    expect(identity.setDisabled).not.toHaveBeenCalled();
  });

  it('lists and searches users with plan, link count and status', async () => {
    repo.listUsers.mockResolvedValue({
      items: [
        record('bob', {
          plan: {
            id: 'pro',
            status: 'active',
            currentPeriodEnd: null,
            cancelAtPeriodEnd: false,
          },
          linkCount: 42,
        }),
        record('eve', { status: 'banned' }),
      ],
      nextCursor: 'eve',
    });

    const res = await call<AdminUserListResponse>(
      'GET',
      '/users?q=%20B&limit=2',
      'admin-1',
    );

    expect(repo.listUsers).toHaveBeenCalledWith('b', 2, undefined);
    expect(res.body).toEqual({
      items: [
        expect.objectContaining({
          uid: 'bob',
          plan: 'pro',
          linkCount: 42,
          status: 'active',
        }),
        expect.objectContaining({ uid: 'eve', plan: 'free', status: 'banned' }),
      ],
      nextCursor: 'eve',
    });
    expect((await call('GET', '/users?limit=500', 'admin-1')).status).toBe(400);
    repo.listUsers.mockResolvedValueOnce(null); // cursor's profile was deleted
    expect((await call('GET', '/users?cursor=gone', 'admin-1')).status).toBe(
      400,
    );
  });

  describe('ban', () => {
    it('disables the user, revokes sessions, mirrors the status, audited', async () => {
      repo.getUser.mockResolvedValue(record('bob', { status: 'banned' }));

      const res = await call('POST', '/users/bob/ban', 'admin-1');

      expect(res).toMatchObject({
        status: 200,
        body: { uid: 'bob', status: 'banned' },
      });
      expect(identity.setDisabled).toHaveBeenCalledWith('bob', true);
      expect(identity.revokeSessions).toHaveBeenCalledWith('bob');
      expect(repo.setStatus).toHaveBeenCalledWith('bob', 'banned');
      expect(audit.begin).toHaveBeenCalledWith({
        actorUid: 'admin-1',
        action: 'user.ban',
        targetUid: 'bob',
      });
      expect(audit.finish).toHaveBeenCalledWith('audit-1', 'applied', {
        completed: ['status', 'disabled', 'sessionsRevoked'],
      });
      // The audit entry exists before the action, and the harmless Firestore
      // step runs before Auth is touched.
      expect(audit.begin.mock.invocationCallOrder[0]).toBeLessThan(
        repo.setStatus.mock.invocationCallOrder[0],
      );
      expect(repo.setStatus.mock.invocationCallOrder[0]).toBeLessThan(
        identity.setDisabled.mock.invocationCallOrder[0],
      );
    });

    it('unbans without revoking anything', async () => {
      await call('POST', '/users/bob/unban', 'admin-1');
      expect(identity.setDisabled).toHaveBeenCalledWith('bob', false);
      expect(repo.setStatus).toHaveBeenCalledWith('bob', 'active');
      expect(identity.revokeSessions).not.toHaveBeenCalled();
    });

    it('protects admins and yourself (403 admin_protected); unknown users 404', async () => {
      expect(
        (await call('POST', '/users/admin-2/ban', 'admin-1')).body,
      ).toMatchObject({
        code: 'admin_protected',
      });
      expect((await call('POST', '/users/admin-1/ban', 'admin-1')).status).toBe(
        403,
      );
      identity.getUser.mockResolvedValueOnce(null);
      expect((await call('POST', '/users/ghost/ban', 'admin-1')).status).toBe(
        404,
      );
      expect(identity.setDisabled).not.toHaveBeenCalled();
      expect(audit.begin).not.toHaveBeenCalled();
    });

    it('marks the audit entry failed and answers 503 when Firebase fails', async () => {
      identity.revokeSessions.mockRejectedValueOnce(
        new Error('auth/internal-error: details'),
      );

      const res = await call('POST', '/users/bob/ban', 'admin-1');

      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).not.toContain('details');
      // Partly applied: the log says exactly which steps ran.
      expect(audit.finish).toHaveBeenCalledWith('audit-1', 'failed', {
        error: 'auth/internal-error: details',
        completed: ['status', 'disabled'],
      });
    });

    it('still answers 200 when only marking the audit entry fails', async () => {
      audit.finish.mockRejectedValueOnce(new Error('firestore blip'));
      expect((await call('POST', '/users/bob/ban', 'admin-1')).status).toBe(
        200,
      );
    });
  });

  describe('impersonate', () => {
    it('returns a custom token carrying impersonatedBy, valid 30 minutes, audited', async () => {
      const res = await call<ImpersonationResponse>(
        'POST',
        '/users/bob/impersonate',
        'admin-1',
      );

      expect(res.body).toEqual({
        customToken: 'custom-token-xyz',
        expiresAt: '2026-06-10T12:30:00.000Z',
      });
      expect(identity.createCustomToken).toHaveBeenCalledWith('bob', {
        impersonatedBy: 'admin-1',
        impersonatedAt: String(NOW.getTime()),
      });
      expect(audit.begin).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'user.impersonate',
          targetUid: 'bob',
        }),
      );
      expect(audit.finish).toHaveBeenCalledWith('audit-1', 'applied', {
        completed: ['tokenMinted'],
      });
    });

    it("can't impersonate admins, yourself, or banned users", async () => {
      expect(
        (await call('POST', '/users/admin-2/impersonate', 'admin-1')).status,
      ).toBe(403);
      expect(
        (await call('POST', '/users/admin-1/impersonate', 'admin-1')).status,
      ).toBe(403);
      identity.getUser.mockResolvedValueOnce({
        uid: 'eve',
        disabled: true,
        role: 'user',
      });
      expect(
        (await call('POST', '/users/eve/impersonate', 'admin-1')).status,
      ).toBe(409);
      expect(identity.createCustomToken).not.toHaveBeenCalled();
    });
  });

  describe('stats', () => {
    it('computes MRR, live subscriptions by plan and signups per day', async () => {
      repo.subscriptions.mockResolvedValue([
        {
          plan: 'pro',
          status: 'active',
          amount: 900,
          currency: 'usd',
          interval: 'month',
        },
        {
          plan: 'pro',
          status: 'past_due',
          amount: 900,
          currency: 'usd',
          interval: 'month',
        },
        {
          plan: 'pro',
          status: 'trialing',
          amount: 900,
          currency: 'usd',
          interval: 'month',
        },
        {
          plan: 'team',
          status: 'active',
          amount: 29_000,
          currency: 'usd',
          interval: 'year',
        },
      ]);
      const counts: Record<string, number> = {
        '2026-06-08': 1,
        '2026-06-10': 2,
      };
      repo.countSignups.mockImplementation(
        async (from: Date) => counts[from.toISOString().slice(0, 10)] ?? 0,
      );

      const res = await call<AdminStatsResponse>(
        'GET',
        '/stats?days=3',
        'admin-1',
      );

      expect(repo.subscriptions).toHaveBeenCalledWith([
        'active',
        'trialing',
        'past_due',
      ]);
      expect(repo.countSignups).toHaveBeenCalledWith(
        new Date('2026-06-08T00:00:00.000Z'),
        new Date('2026-06-09T00:00:00.000Z'),
      );
      expect(res.body).toEqual({
        // Trials aren't revenue yet.
        mrr: [{ currency: 'usd', amount: 900 + 900 + Math.round(29_000 / 12) }],
        liveSubscriptions: { pro: 3, team: 1 },
        signupsPerDay: [
          { date: '2026-06-08', count: 1 },
          { date: '2026-06-09', count: 0 },
          { date: '2026-06-10', count: 2 },
        ],
      });
    });
  });
});

describe('mrrByCurrency', () => {
  it('normalizes intervals, separates currencies and skips unknown amounts', () => {
    expect(
      mrrByCurrency([
        {
          plan: 'pro',
          status: 'active',
          amount: 1200,
          currency: 'usd',
          interval: 'year',
        },
        {
          plan: 'pro',
          status: 'active',
          amount: 100,
          currency: 'usd',
          interval: 'week',
        },
        {
          plan: 'pro',
          status: 'active',
          amount: 900,
          currency: 'eur',
          interval: 'month',
        },
        {
          plan: 'pro',
          status: 'active',
          amount: null,
          currency: 'usd',
          interval: 'month',
        },
        {
          plan: 'pro',
          status: 'active',
          amount: 500,
          currency: 'usd',
          interval: 'fortnight',
        },
      ]),
    ).toEqual([
      { currency: 'eur', amount: 900 },
      { currency: 'usd', amount: Math.round(100 + (100 * 52) / 12) },
    ]);
  });
});
