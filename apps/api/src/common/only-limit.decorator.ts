import { SkipThrottle } from '@nestjs/throttler';
import { RATE_LIMITS, type RateLimitName } from './rate-limit.module';

/** Applies only the named limit to a route or controller (skips the others). */
export const onlyLimit = (name: RateLimitName) =>
  SkipThrottle(
    Object.fromEntries(
      Object.keys(RATE_LIMITS).map((other) => [other, other !== name]),
    ),
  );
