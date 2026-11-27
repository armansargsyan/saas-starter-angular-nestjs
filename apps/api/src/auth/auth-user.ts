import type { Role } from '@saas-starter/shared';

/** The authenticated caller, set on the request by `FirebaseAuthGuard`. */
export interface AuthUser {
  uid: string;
  email: string | null;
  /**
   * Anyone can sign up with an address they don't own. Anything that grants
   * access by email (invites, admin lookups) must require this to be true.
   */
  emailVerified: boolean;
  role: Role;
  /** When the ID token was issued; its claims reflect that moment. */
  tokenIssuedAt: Date;
}

export interface AuthenticatedRequest {
  user?: AuthUser;
}

/** Only the exact claim `'admin'` grants admin; anything else is a user. */
export function roleFromClaim(claim: unknown): Role {
  return claim === 'admin' ? 'admin' : 'user';
}
