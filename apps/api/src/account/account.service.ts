import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  type AccountDeletionBlockedBody,
  type ApiErrorBody,
  type ProfileResponse,
  RECENT_LOGIN_MAX_MINUTES,
  type updateProfileSchema,
} from '@saas-starter/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth-user';
import { BillingProvider } from '../billing/billing.provider';
import { Clock } from '../common/clock';
import { IdentityProvider } from '../firebase/identity.provider';
import {
  AccountRepository,
  type Membership,
  TeamHasMembersError,
  TeamNotOwnedError,
} from './account.repository';

type ProfilePatch = z.output<typeof updateProfileSchema>;

const RECENT_LOGIN_MAX_MS = RECENT_LOGIN_MAX_MINUTES * 60_000;

/**
 * The caller's own account: profile edits and deletion. Strictly the
 * caller's: nothing here takes a uid from the client.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly repo: AccountRepository,
    private readonly billing: BillingProvider,
    private readonly identity: IdentityProvider,
    private readonly clock: Clock,
  ) {}

  /**
   * Firebase Auth holds the profile the web app shows; `users/{uid}` mirrors
   * it for the admin panel and /me.
   */
  async updateProfile(
    user: AuthUser,
    patch: ProfilePatch,
  ): Promise<ProfileResponse> {
    assertNotImpersonated(user);
    const fields: { displayName?: string | null; photoURL?: string | null } = {
      ...(patch.displayName !== undefined && {
        displayName: patch.displayName,
      }),
      ...(patch.photoURL !== undefined && { photoURL: patch.photoURL }),
    };
    await this.identity.updateProfile(user.uid, fields);
    await this.repo.updateProfile(user.uid, fields);
    const record = await this.identity.getUser(user.uid);
    return {
      displayName: record?.displayName ?? null,
      photoURL: record?.photoURL ?? null,
    };
  }

  /**
   * Deletes the account and everything it owns, in an order that makes a
   * retry after any failure safe:
   *
   * 0. Needs a sign-in at most RECENT_LOGIN_MAX_MINUTES old (403
   *    `requires_recent_login`): a stolen token alone can't delete it.
   * 1. Refuse (409 `owns_team_with_members`) while the caller owns a team
   *    with other members: those people would lose the team's links.
   * 2. Lock every team the caller owns alone, re-checking its members in
   *    the same transaction: from here on nobody can join or be invited
   *    (409 `team_deleting`). Someone who joined since step 1 gets the
   *    409 of step 1 instead, before anything has changed. Then lock the
   *    personal workspace (teams first, so a team that fails to lock
   *    doesn't leave it locked). Locked workspaces refuse checkouts and the
   *    billing portal. A lock left by an attempt that's given up lapses
   *    after DELETION_LOCK_MS.
   * 3. Cancel every Stripe subscription that could still bill, of the
   *    personal workspace and the locked teams, and expire open checkouts.
   *    A Stripe failure stops here, before any data is gone (503, retry).
   *    The Stripe customer itself is kept: its invoices are needed for
   *    accounting and tax.
   * 4. Delete the team docs first, each re-checked in its transaction
   *    (then invites to them are invalid, whatever the lock's age), then
   *    sweep each team's and the personal workspace's data: links,
   *    analytics, workspace docs, subscription mirrors (codes stay retired).
   *    A retry finds the team docs gone and only sweeps.
   * 5. Leave every other team (revoking the invites the caller sent there),
   *    then delete `users/{uid}`.
   * 6. Delete the Firebase Auth user last: until then the caller can still
   *    sign in and retry; after it, every token they hold is rejected.
   *
   * It runs in the request: a very large workspace (tens of thousands of
   * links) may outlast a proxy timeout. Every step is idempotent, so the
   * retry continues where it stopped; the web app also treats "the user is
   * gone" after a lost response as success.
   *
   * Known limit: a request already in flight (e.g. creating a link) when the
   * data is deleted can still land before step 6; it is orphaned, not
   * reachable by anyone.
   */
  async deleteAccount(user: AuthUser): Promise<void> {
    assertNotImpersonated(user);
    const now = this.clock.now();
    if (now.getTime() - user.authTime.getTime() > RECENT_LOGIN_MAX_MS) {
      const body: ApiErrorBody<'requires_recent_login'> = {
        statusCode: 403,
        code: 'requires_recent_login',
        message: 'Sign in again to delete your account.',
      };
      throw new ForbiddenException(body);
    }

    const memberships = await this.repo.listMemberships(user.uid);
    const owned = memberships.filter((m) => m.role === 'owner');
    const blocking = owned.filter((m) => m.teamExists && m.memberCount > 1);
    if (blocking.length) throw ownsTeams(blocking);

    try {
      for (const team of owned) {
        await this.repo.lockOwnedTeam(team.teamId, user.uid, now);
      }
      await this.repo.lockPersonalWorkspace(user.uid, now);
      for (const workspaceId of [user.uid, ...owned.map((m) => m.teamId)]) {
        await this.cancelBilling(workspaceId);
      }
      for (const team of owned) {
        await this.repo.deleteOwnedTeamDoc(team.teamId, user.uid);
      }
      for (const team of owned) {
        await this.repo.deleteWorkspaceData(team.teamId);
      }
      await this.repo.deleteWorkspaceData(user.uid);
      for (const team of memberships.filter((m) => m.role !== 'owner')) {
        await this.repo.leaveTeam(team.teamId, user.uid);
      }
      await this.repo.deleteProfile(user.uid);
      await this.identity.deleteUser(user.uid);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (err instanceof TeamHasMembersError) {
        // Someone joined between the check and the lock.
        const team = owned.find((m) => m.teamId === err.teamId);
        throw ownsTeams(team ? [team] : []);
      }
      if (err instanceof TeamNotOwnedError) {
        // Inconsistent data a retry won't fix: needs a person to look.
        this.logger.error(err.message);
        throw new InternalServerErrorException(
          'Your account could not be deleted. Please contact support.',
        );
      }
      this.logger.error(
        `Account deletion for ${user.uid} stopped: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'Your account could not be fully deleted. Please try again.',
      );
    }
    // A /me request racing the deletion can recreate the profile from the
    // auth user until that is gone: delete it once more. Best effort, the
    // account is already deleted and a retry can't sign in any more.
    try {
      await this.repo.deleteProfile(user.uid);
    } catch (err) {
      this.logger.warn(
        `Profile cleanup after deleting ${user.uid} failed: ${(err as Error).message}`,
      );
    }
    this.logger.log(`Deleted account ${user.uid}`);
  }

  private async cancelBilling(workspaceId: string): Promise<void> {
    const customerId = await this.repo.stripeCustomerId(workspaceId);
    if (!customerId) return;
    // Ask Stripe, not the synced plan: it lags until the webhook lands, and
    // doesn't track subscriptions that aren't live yet (incomplete, paused).
    await this.billing.cancelAllSubscriptions(customerId);
    // An unpaid checkout must not start a subscription after the account is gone.
    await this.billing.expireOpenCheckoutSessions(customerId);
  }
}

/** The auth guard already refuses writes when impersonating; never rely on that alone here. */
function assertNotImpersonated(user: AuthUser): void {
  if (user.impersonatedBy === undefined) return;
  const body: ApiErrorBody<'impersonation_read_only'> = {
    statusCode: 403,
    code: 'impersonation_read_only',
    message: 'Impersonated sessions are read-only',
  };
  throw new ForbiddenException(body);
}

function ownsTeams(teams: Membership[]): ConflictException {
  const names = teams.map((t) => t.teamName).join(', ');
  const body: AccountDeletionBlockedBody = {
    statusCode: 409,
    code: 'owns_team_with_members',
    message: `You own ${teams.length === 1 ? 'a team' : 'teams'} with other members (${names}). Remove the other members first, then delete your account.`,
    teams: teams.map((t) => ({ id: t.teamId, name: t.teamName })),
  };
  return new ConflictException(body);
}
