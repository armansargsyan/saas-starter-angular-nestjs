import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IdentityProvider } from '../firebase/identity.provider';
import { type AuthenticatedRequest, roleFromClaim } from './auth-user';
import { IS_PUBLIC_KEY } from './decorators';

const BEARER = /^Bearer\s+(\S+)$/i;

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

    request.user = {
      uid: verified.uid,
      email: verified.email ?? null,
      emailVerified: verified.emailVerified,
      role: roleFromClaim(verified.role),
      tokenIssuedAt: verified.issuedAt,
    };
    return true;
  }
}
