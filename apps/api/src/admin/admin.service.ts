import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  type AdminStatsResponse,
  type AdminUser,
  type AdminUserListResponse,
  type ApiErrorBody,
  effectivePlanId,
  IMPERSONATION_MAX_MINUTES,
  type ImpersonationResponse,
} from '@saas-starter/shared';
import type { AuthUser } from '../auth/auth-user';
import { Clock } from '../common/clock';
import {
  IdentityProvider,
  type IdentityUser,
} from '../firebase/identity.provider';
import {
  AdminRepository,
  type AdminUserRecord,
  MAX_SUBSCRIPTIONS_SCANNED,
  type SubscriptionRecord,
} from './admin.repository';
import { type AuditAction, AuditLogRepository } from './audit-log.repository';

const DAY_MS = 86_400_000;
/** Subscriptions that grant a plan. */
const LIVE_STATUSES = ['active', 'trialing', 'past_due'] as const;
/** Of those, the ones being billed: they count towards MRR. */
const BILLING_STATUSES: ReadonlySet<string> = new Set(['active', 'past_due']);
/** Recurring amount → per month. */
const MONTHLY_FACTOR: Record<string, number> = {
  month: 1,
  year: 1 / 12,
  week: 52 / 12,
  day: 365 / 12,
};

/** Runs steps in order and remembers which ones completed. */
type Steps = (name: string, step: () => Promise<unknown>) => Promise<void>;

/**
 * Admin actions. Targets are checked against Firebase Auth (the source of
 * truth for role and ban), and every action is audit-logged around its run.
 *
 * Known tradeoff: an admin's own impersonation session isn't re-checked
 * against their admin status on each request; demoting or banning an admin
 * doesn't end a session they already started (it lasts at most 30 minutes).
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly repo: AdminRepository,
    private readonly audit: AuditLogRepository,
    private readonly identity: IdentityProvider,
    private readonly clock: Clock,
  ) {}

  async listUsers(query: {
    q?: string;
    limit: number;
    cursor?: string;
  }): Promise<AdminUserListResponse> {
    const page = await this.repo.listUsers(
      query.q || undefined,
      query.limit,
      query.cursor,
    );
    if (!page) throw new BadRequestException('That cursor is no longer valid');
    return { items: page.items.map(toAdminUser), nextCursor: page.nextCursor };
  }

  async getUser(uid: string): Promise<AdminUser> {
    const user = await this.repo.getUser(uid);
    if (!user) throw new NotFoundException('User not found');
    return toAdminUser(user);
  }

  /**
   * Mirrors `status: banned` first (the harmless step), then disables
   * sign-in and revokes sessions, so the guard's revocation check rejects
   * even tokens issued before the ban. Every step is idempotent: retry on failure.
   * If a later step fails, the user list (built from the Firestore status)
   * already shows "banned" while sign-in still works; the 503 and the audit
   * entry's `completed` steps say so, and a retry finishes the ban.
   */
  async ban(admin: AuthUser, uid: string): Promise<AdminUser> {
    await this.targetUser(admin, uid);
    await this.audited(admin, 'user.ban', uid, async (step) => {
      await step('status', () => this.repo.setStatus(uid, 'banned'));
      await step('disabled', () => this.identity.setDisabled(uid, true));
      await step('sessionsRevoked', () => this.identity.revokeSessions(uid));
    });
    return this.getUserOrStub(uid);
  }

  async unban(admin: AuthUser, uid: string): Promise<AdminUser> {
    await this.targetUser(admin, uid);
    await this.audited(admin, 'user.unban', uid, async (step) => {
      await step('enabled', () => this.identity.setDisabled(uid, false));
      await step('status', () => this.repo.setStatus(uid, 'active'));
    });
    return this.getUserOrStub(uid);
  }

  /**
   * A custom token to sign in as the user, carrying `impersonatedBy` and the
   * minting time. The auth guard keeps the session read-only, non-admin, and
   * ends it IMPERSONATION_MAX_MINUTES after minting (or sign-in, if sooner).
   */
  async impersonate(
    admin: AuthUser,
    uid: string,
  ): Promise<ImpersonationResponse> {
    const target = await this.targetUser(admin, uid);
    if (target.disabled) {
      throw new ConflictException('Banned users cannot be impersonated');
    }
    const mintedAt = this.clock.now();
    let customToken = '';
    await this.audited(admin, 'user.impersonate', uid, async (step) => {
      await step('tokenMinted', async () => {
        customToken = await this.identity.createCustomToken(uid, {
          impersonatedBy: admin.uid,
          impersonatedAt: String(mintedAt.getTime()),
        });
      });
    });
    return {
      customToken,
      expiresAt: new Date(
        mintedAt.getTime() + IMPERSONATION_MAX_MINUTES * 60_000,
      ).toISOString(),
    };
  }

  async stats(days: number): Promise<AdminStatsResponse> {
    const now = this.clock.now();
    const dates = Array.from({ length: days }, (_, i) =>
      utcDay(new Date(now.getTime() - (days - 1 - i) * DAY_MS)),
    );
    const [subscriptions, perDay] = await Promise.all([
      this.repo.subscriptions(LIVE_STATUSES),
      // One count aggregation per day: exact, and cheap at any scale.
      Promise.all(
        dates.map((date) => {
          const from = new Date(`${date}T00:00:00.000Z`);
          return this.repo.countSignups(
            from,
            new Date(from.getTime() + DAY_MS),
          );
        }),
      ),
    ]);
    if (subscriptions.length >= MAX_SUBSCRIPTIONS_SCANNED) {
      this.logger.warn(
        `MRR computed from the first ${MAX_SUBSCRIPTIONS_SCANNED} subscriptions only`,
      );
    }

    return {
      mrr: mrrByCurrency(
        subscriptions.filter((sub) => BILLING_STATUSES.has(sub.status)),
      ),
      liveSubscriptions: {
        pro: subscriptions.filter((s) => s.plan === 'pro').length,
        team: subscriptions.filter((s) => s.plan === 'team').length,
      },
      signupsPerDay: dates.map((date, i) => ({ date, count: perDay[i] })),
    };
  }

  /** The target, from Firebase Auth (the source of truth for role and ban). */
  private async targetUser(
    admin: AuthUser,
    uid: string,
  ): Promise<IdentityUser> {
    if (uid === admin.uid) throw protectedUser('You can’t do that to yourself');
    const target = await this.identity.getUser(uid);
    if (!target) throw new NotFoundException('User not found');
    if (target.role === 'admin') {
      throw protectedUser('Admins can’t be banned or impersonated');
    }
    return target;
  }

  /**
   * Audit first (pending), run the steps, then mark applied, or failed with
   * the steps that did complete, so a partial action is never misreported.
   */
  private async audited(
    admin: AuthUser,
    action: AuditAction,
    targetUid: string,
    run: (step: Steps) => Promise<void>,
  ): Promise<void> {
    const id = await this.audit.begin({
      actorUid: admin.uid,
      action,
      targetUid,
    });
    const completed: string[] = [];
    const step: Steps = async (name, fn) => {
      await fn();
      completed.push(name);
    };
    try {
      await run(step);
    } catch (err) {
      const error = (err as Error).message;
      this.logger.error(
        `${action} on ${targetUid} failed after [${completed.join(', ')}]: ${error}`,
      );
      await this.finishQuietly(id, 'failed', { error, completed });
      throw new ServiceUnavailableException('The action failed; try again');
    }
    // The action happened: a failure to mark it must not look like it didn't.
    await this.finishQuietly(id, 'applied', { completed });
  }

  private async finishQuietly(
    id: string,
    status: 'applied' | 'failed',
    details: { error?: string; completed: string[] },
  ): Promise<void> {
    try {
      await this.audit.finish(id, status, details);
    } catch (err) {
      this.logger.error(
        `Audit entry ${id} could not be marked ${status}: ${(err as Error).message}`,
      );
    }
  }

  /** After a ban/unban the profile may not exist yet (never signed in to the app). */
  private async getUserOrStub(uid: string): Promise<AdminUser> {
    const user = await this.repo.getUser(uid);
    if (user) return toAdminUser(user);
    const identity = await this.identity.getUser(uid);
    return {
      uid,
      email: identity?.email ?? null,
      displayName: identity?.displayName ?? null,
      role: identity?.role ?? 'user',
      status: identity?.disabled ? 'banned' : 'active',
      plan: 'free',
      linkCount: 0,
      createdAt: null,
    };
  }
}

/** Only the plans the app sells (pro, team) are counted; amounts must be known. */
export function mrrByCurrency(
  subscriptions: SubscriptionRecord[],
): AdminStatsResponse['mrr'] {
  const totals = new Map<string, number>();
  for (const sub of subscriptions) {
    const factor = sub.interval ? MONTHLY_FACTOR[sub.interval] : undefined;
    if (sub.amount === null || !sub.currency || factor === undefined) continue;
    totals.set(
      sub.currency,
      (totals.get(sub.currency) ?? 0) + sub.amount * factor,
    );
  }
  return [...totals.entries()]
    .map(([currency, amount]) => ({ currency, amount: Math.round(amount) }))
    .sort((a, b) => b.amount - a.amount);
}

function toAdminUser(user: AdminUserRecord): AdminUser {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    plan: effectivePlanId(user.plan),
    linkCount: user.linkCount,
    createdAt: user.createdAt?.toISOString() ?? null,
  };
}

function protectedUser(message: string) {
  const body: ApiErrorBody<'admin_protected'> = {
    statusCode: 403,
    code: 'admin_protected',
    message,
  };
  return new ForbiddenException(body);
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
