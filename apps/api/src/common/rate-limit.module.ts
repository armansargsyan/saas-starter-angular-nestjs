import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { UserThrottlerGuard } from './user-throttler.guard';

/** Named limits, per user (see UserThrottlerGuard), in memory per instance. */
export const RATE_LIMITS = {
  /** Link creation. */
  createLink: { ttl: 60_000, limit: 30 },
  /** Invite preview/accept/decline, against token guessing. */
  invites: { ttl: 60_000, limit: 20 },
  /** Creating teams and sending invites. */
  teamWrites: { ttl: 60_000, limit: 30 },
  /** Profile edits and account deletion. */
  account: { ttl: 60_000, limit: 10 },
} as const;
export type RateLimitName = keyof typeof RATE_LIMITS;

/**
 * The throttler module is global, so it's configured once, here; routes pick
 * their limit with `@UseGuards(UserThrottlerGuard)` + `onlyLimit(...)`.
 */
@Module({
  imports: [
    ThrottlerModule.forRoot(
      Object.entries(RATE_LIMITS).map(([name, limit]) => ({ name, ...limit })),
    ),
  ],
  providers: [UserThrottlerGuard],
  exports: [UserThrottlerGuard],
})
export class RateLimitModule {}
