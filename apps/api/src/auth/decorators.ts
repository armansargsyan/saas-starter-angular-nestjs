import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Role } from '@saas-starter/shared';
import type { AuthenticatedRequest, AuthUser } from './auth-user';

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const ROLES_KEY = 'auth:roles';

/** Opts a route or controller out of the global Firebase auth guard. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Restricts a route or controller to callers with one of these roles. */
export const Roles = (...roles: [Role, ...Role[]]) =>
  SetMetadata(ROLES_KEY, roles);

/** The authenticated caller. Only valid on routes that are not `@Public()`. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const user = ctx.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user) {
      // A programming error (used on a public route), not a client error.
      throw new Error('@CurrentUser() used on a route without an auth user');
    }
    return user;
  },
);
