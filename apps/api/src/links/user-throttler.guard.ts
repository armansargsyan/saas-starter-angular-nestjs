import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthenticatedRequest } from '../auth/auth-user';

/** Rate limits per signed-in user (set by the global auth guard), else per IP. */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(
    req: AuthenticatedRequest & { ip?: string },
  ): Promise<string> {
    return req.user ? `uid:${req.user.uid}` : `ip:${req.ip ?? 'unknown'}`;
  }
}
