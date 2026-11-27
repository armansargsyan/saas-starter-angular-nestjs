import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import type { BillingProvider } from '../billing/billing.provider';
import type { Clock } from '../common/clock';
import type { IdentityProvider } from '../firebase/identity.provider';
import {
  type AccountRepository,
  type Membership,
  TeamHasMembersError,
  TeamNotOwnedError,
} from './account.repository';
import { AccountService } from './account.service';

const NOW = new Date('2026-06-01T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const alice: AuthUser = {
  uid: 'alice',
  email: 'alice@example.com',
  emailVerified: true,
  role: 'user',
  tokenIssuedAt: NOW,
  authTime: minutesAgo(1),
};

const membership = (overrides: Partial<Membership>): Membership => ({
  teamId: 't1',
  role: 'member',
  teamExists: true,
  teamName: 'Acme',
  memberCount: 3,
  ...overrides,
});

type Mocks<K extends string> = Record<K, ReturnType<typeof vi.fn>>;

describe('AccountService', () => {
  /** Every write, in order, across repo, billing and identity. */
  let calls: string[];
  const record =
    (name: string, result?: unknown) =>
    async (...args: unknown[]) => {
      calls.push(
        `${name}(${args
          .filter((a) => !(a instanceof Date))
          .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(',')})`,
      );
      return result;
    };

  let repo: Mocks<keyof AccountRepository>;
  let billing: Mocks<'cancelAllSubscriptions' | 'expireOpenCheckoutSessions'>;
  let identity: Mocks<'updateProfile' | 'deleteUser' | 'getUser'>;
  let service: AccountService;

  beforeEach(() => {
    calls = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    repo = {
      listMemberships: vi.fn(async () => []),
      lockOwnedTeam: vi.fn(record('lock')),
      stripeCustomerId: vi.fn(async () => null),
      lockPersonalWorkspace: vi.fn(record('lockPersonal')),
      deleteOwnedTeamDoc: vi.fn(record('deleteTeamDoc')),
      deleteWorkspaceData: vi.fn(record('deleteWorkspaceData')),
      leaveTeam: vi.fn(record('leaveTeam')),
      updateProfile: vi.fn(record('repo.updateProfile')),
      deleteProfile: vi.fn(record('deleteProfile')),
    };
    billing = {
      cancelAllSubscriptions: vi.fn(record('cancelAll', [])),
      expireOpenCheckoutSessions: vi.fn(record('expireCheckouts')),
    };
    identity = {
      updateProfile: vi.fn(record('identity.updateProfile')),
      deleteUser: vi.fn(record('deleteUser')),
      getUser: vi.fn(async () => ({
        uid: 'alice',
        displayName: 'Ada',
        photoURL: null,
      })),
    };
    service = new AccountService(
      repo as unknown as AccountRepository,
      billing as unknown as BillingProvider,
      identity as unknown as IdentityProvider,
      { now: () => NOW } as Clock,
    );
  });

  describe('deleteAccount', () => {
    it('deletes the personal data, then the profile, then the auth user', async () => {
      await service.deleteAccount(alice);

      expect(calls).toEqual([
        'lockPersonal(alice)',
        'deleteWorkspaceData(alice)',
        'deleteProfile(alice)',
        'deleteUser(alice)',
        'deleteProfile(alice)',
      ]);
      expect(billing.cancelAllSubscriptions).not.toHaveBeenCalled();
    });

    it('cancels the personal subscriptions through the provider before deleting anything', async () => {
      repo.stripeCustomerId.mockImplementation(async (ws: string) =>
        ws === 'alice' ? 'cus_1' : null,
      );

      await service.deleteAccount(alice);

      expect(calls).toEqual([
        'lockPersonal(alice)',
        'cancelAll(cus_1)',
        'expireCheckouts(cus_1)',
        'deleteWorkspaceData(alice)',
        'deleteProfile(alice)',
        'deleteUser(alice)',
        'deleteProfile(alice)',
      ]);
    });

    it.each([
      ['an old sign-in', minutesAgo(6)],
      ['a sign-in just past the limit', new Date(minutesAgo(5).getTime() - 1)],
    ])(
      'needs a recent sign-in (403 requires_recent_login): %s',
      async (_, authTime) => {
        const err = await service
          .deleteAccount({ ...alice, authTime })
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err as ForbiddenException).getResponse()).toMatchObject({
          code: 'requires_recent_login',
        });
        expect(repo.listMemberships).not.toHaveBeenCalled();
        expect(calls).toEqual([]);
      },
    );

    it('accepts a sign-in exactly 5 minutes old', async () => {
      await service.deleteAccount({ ...alice, authTime: minutesAgo(5) });
      expect(identity.deleteUser).toHaveBeenCalled();
    });

    it('refuses while the caller owns a team with other members', async () => {
      repo.listMemberships.mockResolvedValue([
        membership({ teamId: 't1', role: 'owner', teamName: 'Acme' }),
        membership({ teamId: 't2', role: 'member' }),
      ]);

      const err = await service.deleteAccount(alice).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: 'owns_team_with_members',
        teams: [{ id: 't1', name: 'Acme' }],
      });
      expect(calls).toEqual([]);
      expect(repo.stripeCustomerId).not.toHaveBeenCalled();
    });

    it('locks the teams it owns alone before billing, then takes them along, and leaves the others', async () => {
      repo.listMemberships.mockResolvedValue([
        membership({ teamId: 'solo', role: 'owner', memberCount: 1 }),
        // A team doc already gone from an earlier, interrupted attempt.
        membership({
          teamId: 'half',
          role: 'owner',
          teamExists: false,
          memberCount: 1,
        }),
        membership({ teamId: 'other', role: 'admin' }),
      ]);
      repo.stripeCustomerId.mockImplementation(async (ws: string) =>
        ws === 'solo' ? 'cus_team' : null,
      );

      await service.deleteAccount(alice);

      expect(repo.lockOwnedTeam).toHaveBeenCalledWith('solo', 'alice', NOW);
      expect(repo.lockPersonalWorkspace).toHaveBeenCalledWith('alice', NOW);
      expect(calls).toEqual([
        'lock(solo,alice)',
        'lock(half,alice)',
        'lockPersonal(alice)',
        'cancelAll(cus_team)',
        'expireCheckouts(cus_team)',
        // Every team doc first (invites die with it), then the sweeps.
        'deleteTeamDoc(solo,alice)',
        'deleteTeamDoc(half,alice)',
        'deleteWorkspaceData(solo)',
        'deleteWorkspaceData(half)',
        'deleteWorkspaceData(alice)',
        'leaveTeam(other,alice)',
        'deleteProfile(alice)',
        'deleteUser(alice)',
        'deleteProfile(alice)',
      ]);
    });

    it('answers 409 when someone joined a solo team meanwhile, with billing and data untouched', async () => {
      repo.listMemberships.mockResolvedValue([
        membership({ teamId: 'a', role: 'owner', memberCount: 1 }),
        membership({
          teamId: 'b',
          role: 'owner',
          memberCount: 1,
          teamName: 'B',
        }),
      ]);
      repo.stripeCustomerId.mockResolvedValue('cus_1');
      repo.lockOwnedTeam.mockImplementation(async (teamId: string) => {
        if (teamId === 'b') throw new TeamHasMembersError('b');
      });

      const err = await service.deleteAccount(alice).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        teams: [{ id: 'b', name: 'B' }],
      });
      expect(billing.cancelAllSubscriptions).not.toHaveBeenCalled();
      expect(billing.expireOpenCheckoutSessions).not.toHaveBeenCalled();
      expect(repo.deleteOwnedTeamDoc).not.toHaveBeenCalled();
      // Teams lock first: a failed team lock leaves the personal one alone.
      expect(repo.lockPersonalWorkspace).not.toHaveBeenCalled();
      expect(repo.deleteWorkspaceData).not.toHaveBeenCalled();
      expect(identity.deleteUser).not.toHaveBeenCalled();
    });

    it('stops with a 500 (no retry loop) on a team whose owner field disagrees', async () => {
      repo.listMemberships.mockResolvedValue([
        membership({ teamId: 'odd', role: 'owner', memberCount: 1 }),
      ]);
      repo.lockOwnedTeam.mockRejectedValue(
        new TeamNotOwnedError('odd', 'alice'),
      );

      await expect(service.deleteAccount(alice)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(billing.cancelAllSubscriptions).not.toHaveBeenCalled();
    });

    it('stops before deleting data when Stripe fails (503, nothing leaked)', async () => {
      repo.stripeCustomerId.mockResolvedValue('cus_1');
      billing.cancelAllSubscriptions.mockRejectedValue(
        new Error('stripe: secret detail'),
      );

      const err = await service.deleteAccount(alice).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(
        JSON.stringify((err as ServiceUnavailableException).getResponse()),
      ).not.toContain('secret detail');
      expect(repo.deleteWorkspaceData).not.toHaveBeenCalled();
      expect(identity.deleteUser).not.toHaveBeenCalled();
    });

    it('keeps the auth user when a data step fails, so a retry can finish', async () => {
      repo.deleteWorkspaceData.mockRejectedValueOnce(new Error('unavailable'));

      await expect(service.deleteAccount(alice)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(identity.deleteUser).not.toHaveBeenCalled();

      await service.deleteAccount(alice);
      expect(identity.deleteUser).toHaveBeenCalledWith('alice');
    });

    it('deletes the profile again after the auth user, best effort', async () => {
      repo.deleteProfile
        .mockImplementationOnce(record('deleteProfile'))
        .mockRejectedValueOnce(new Error('unavailable'));

      await expect(service.deleteAccount(alice)).resolves.toBeUndefined();
      expect(identity.deleteUser).toHaveBeenCalledWith('alice');
      expect(repo.deleteProfile).toHaveBeenCalledTimes(2);
    });

    it('is refused in an impersonated session', async () => {
      await expect(
        service.deleteAccount({ ...alice, impersonatedBy: 'admin-1' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.listMemberships).not.toHaveBeenCalled();
    });
  });

  describe('updateProfile', () => {
    it('updates Firebase Auth, then the users mirror, with only the given fields', async () => {
      const result = await service.updateProfile(alice, { displayName: 'Ada' });

      expect(calls).toEqual([
        'identity.updateProfile(alice,{"displayName":"Ada"})',
        'repo.updateProfile(alice,{"displayName":"Ada"})',
      ]);
      expect(result).toEqual({ displayName: 'Ada', photoURL: null });
    });

    it('passes null through to clear a field', async () => {
      await service.updateProfile(alice, { photoURL: null });
      expect(identity.updateProfile).toHaveBeenCalledWith('alice', {
        photoURL: null,
      });
    });

    it('does not need a recent sign-in', async () => {
      await service.updateProfile(
        { ...alice, authTime: minutesAgo(600) },
        { displayName: 'Ada' },
      );
      expect(identity.updateProfile).toHaveBeenCalled();
    });

    it('is refused in an impersonated session', async () => {
      await expect(
        service.updateProfile(
          { ...alice, impersonatedBy: 'admin-1' },
          { displayName: 'x' },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(identity.updateProfile).not.toHaveBeenCalled();
    });
  });
});
