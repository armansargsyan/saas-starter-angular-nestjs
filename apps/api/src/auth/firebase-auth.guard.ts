import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  type ApiErrorBody,
  IMPERSONATION_MAX_MINUTES,
} from '@saas-starter/shared';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IdentityProvider } from '../firebase/identity.provider';
import { type AuthenticatedRequest, roleFromClaim } from './auth-user';
import { IS_PUBLIC_KEY } from './decorators';

const BEARER = /^Bearer\s+(\S+)$/i;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const IMPERSONATION_MAX_MS = IMPERSONATION_MAX_MINUTES * 60_000;

/**
 * Global guard: every route needs a valid Firebase ID token unless it is
 * marked `@Public()`. Sets `request.user`.
 */
@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identity: IdentityProvider,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & AuthenticatedRequest>();
    const token = BEARER.exec(request.headers.authorization ?? '')?.[1];
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let verified;
    try {
      verified = await this.identity.verifyIdToken(token);
    } catch {
      // Don't leak provider errors (expired vs revoked vs malformed).
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Only a non-empty admin uid marks impersonation.
    const impersonatedBy =
      typeof verified.impersonatedBy === 'string' && verified.impersonatedBy
        ? verified.impersonatedBy
        : null;
    const impersonating = impersonatedBy !== null;
    if (impersonating) {
      // Custom-token sessions can be refreshed indefinitely, and a custom
      // token can be redeemed up to an hour after minting: the window runs
      // from minting *and* from sign-in, whichever ends first. No writes.
      const now = Date.now();
      const mintedAt = verified.impersonatedAt?.getTime();
      if (
        mintedAt === undefined ||
        now - mintedAt > IMPERSONATION_MAX_MS ||
        now - verified.authTime.getTime() > IMPERSONATION_MAX_MS
      ) {
        throw new UnauthorizedException('Impersonation session expired');
      }
      if (!SAFE_METHODS.has(request.method)) {
        const body: ApiErrorBody<'impersonation_read_only'> = {
          statusCode: 403,
          code: 'impersonation_read_only',
          message: 'Impersonated sessions are read-only',
        };
        throw new ForbiddenException(body);
      }
    }

    request.user = {
      uid: verified.uid,
      email: verified.email ?? null,
      emailVerified: verified.emailVerified,
      // Never admin while impersonated, even if the target was promoted since.
      role: impersonating ? 'user' : roleFromClaim(verified.role),
      tokenIssuedAt: verified.issuedAt,
      ...(impersonatedBy !== null && { impersonatedBy }),
    };
    return true;
  }
}
