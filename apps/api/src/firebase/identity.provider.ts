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
  /** Custom claim; anything other than `'admin'` is a regular user. */
  role?: unknown;
}

export interface IdentityUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
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
    };
  }
}
