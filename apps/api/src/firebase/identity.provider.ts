import { Inject, Injectable } from '@nestjs/common';
import type { Auth } from 'firebase-admin/auth';
import { FIREBASE_AUTH } from './firebase.tokens';

/** The claims the api reads from a verified Firebase ID token. */
export interface VerifiedIdToken {
  uid: string;
  email?: string;
  emailVerified: boolean;
  /** When this ID token was issued (`iat`). */
  issuedAt: Date;
  /** When the user signed in (`auth_time`); refreshes keep it. */
  authTime: Date;
  /** Admin uid, for a session started from an impersonation custom token. */
  impersonatedBy: string | null;
  /** When that impersonation token was minted (claim `impersonatedAt`, epoch ms). */
  impersonatedAt: Date | null;
  /** Custom claim; anything other than `'admin'` is a regular user. */
  role?: unknown;
}

export interface IdentityUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  disabled: boolean;
  /** From the `role` custom claim. */
  role: 'user' | 'admin';
}

/**
 * Identity operations the api needs, behind an abstract class so guards and
 * services can be tested with a mock instead of Firebase.
 */
export abstract class IdentityProvider {
  /** Rejects when the token is invalid, expired, revoked or the user disabled. */
  abstract verifyIdToken(idToken: string): Promise<VerifiedIdToken>;
  /** Null when the user no longer exists. */
  abstract getUser(uid: string): Promise<IdentityUser | null>;
  /** Disables (bans) or re-enables sign-in. */
  abstract setDisabled(uid: string, disabled: boolean): Promise<void>;
  /** Ends every session: existing ID tokens fail the revocation check. */
  abstract revokeSessions(uid: string): Promise<void>;
  /** A custom token for signing in as `uid` with extra claims (impersonation). */
  abstract createCustomToken(
    uid: string,
    claims: Record<string, string>,
  ): Promise<string>;
}

@Injectable()
export class FirebaseIdentityProvider extends IdentityProvider {
  constructor(@Inject(FIREBASE_AUTH) private readonly auth: Auth) {
    super();
  }

  async verifyIdToken(idToken: string): Promise<VerifiedIdToken> {
    // checkRevoked: also rejects revoked sessions and disabled (banned) users.
    const decoded = await this.auth.verifyIdToken(idToken, true);
    return {
      uid: decoded.uid,
      email: decoded.email,
      emailVerified: decoded.email_verified === true,
      issuedAt: new Date(decoded.iat * 1000),
      authTime: new Date(decoded.auth_time * 1000),
      impersonatedBy:
        typeof decoded['impersonatedBy'] === 'string'
          ? decoded['impersonatedBy']
          : null,
      impersonatedAt: toDateClaim(decoded['impersonatedAt']),
      role: decoded['role'],
    };
  }

  async getUser(uid: string): Promise<IdentityUser | null> {
    let record;
    try {
      record = await this.auth.getUser(uid);
    } catch (err) {
      if ((err as { code?: unknown }).code === 'auth/user-not-found') {
        return null;
      }
      throw err;
    }
    return {
      uid: record.uid,
      email: record.email ?? null,
      displayName: record.displayName ?? null,
      photoURL: record.photoURL ?? null,
      disabled: record.disabled === true,
      role: record.customClaims?.['role'] === 'admin' ? 'admin' : 'user',
    };
  }

  async setDisabled(uid: string, disabled: boolean): Promise<void> {
    await this.auth.updateUser(uid, { disabled });
  }

  async revokeSessions(uid: string): Promise<void> {
    await this.auth.revokeRefreshTokens(uid);
  }

  createCustomToken(
    uid: string,
    claims: Record<string, string>,
  ): Promise<string> {
    return this.auth.createCustomToken(uid, claims);
  }
}

function toDateClaim(value: unknown): Date | null {
  const ms = typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}
