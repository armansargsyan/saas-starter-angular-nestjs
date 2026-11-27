import { Inject, Injectable } from '@nestjs/common';
import type { Role } from '@saas-starter/shared';
import {
  FieldValue,
  type Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.tokens';

export type UserStatus = 'active' | 'banned';

/** `users/{uid}`. `role` mirrors the custom claim, which stays the source of truth. */
export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  role: Role;
  status: UserStatus;
  /** Set by role changes (grant-admin); null if never changed. */
  roleChangedAt: Date | null;
}

export abstract class UsersRepository {
  abstract get(uid: string): Promise<UserProfile | null>;
  /** Creates the profile, or returns the existing one if it already exists. */
  abstract createIfAbsent(profile: UserProfile): Promise<UserProfile>;
  abstract setRole(uid: string, role: Role): Promise<void>;
}

const ALREADY_EXISTS = 6;

@Injectable()
export class FirestoreUsersRepository extends UsersRepository {
  constructor(@Inject(FIRESTORE) private readonly db: Firestore) {
    super();
  }

  async get(uid: string): Promise<UserProfile | null> {
    const snap = await this.db.collection('users').doc(uid).get();
    return snap.exists ? toProfile(uid, snap.data() ?? {}) : null;
  }

  async createIfAbsent(profile: UserProfile): Promise<UserProfile> {
    const { uid, roleChangedAt: _unused, ...fields } = profile;
    try {
      await this.db
        .collection('users')
        .doc(uid)
        .create({ ...fields, createdAt: FieldValue.serverTimestamp() });
      return profile;
    } catch (err) {
      // A concurrent first request created it first: use theirs.
      if ((err as { code?: unknown }).code === ALREADY_EXISTS) {
        const existing = await this.get(uid);
        if (existing) return existing;
      }
      throw err;
    }
  }

  async setRole(uid: string, role: Role): Promise<void> {
    await this.db.collection('users').doc(uid).update({ role });
  }
}

function toProfile(uid: string, data: Record<string, unknown>): UserProfile {
  const str = (value: unknown) => (typeof value === 'string' ? value : null);
  return {
    uid,
    email: str(data['email']),
    displayName: str(data['displayName']),
    photoURL: str(data['photoURL']),
    role: data['role'] === 'admin' ? 'admin' : 'user',
    status: data['status'] === 'banned' ? 'banned' : 'active',
    roleChangedAt:
      data['roleChangedAt'] instanceof Timestamp
        ? data['roleChangedAt'].toDate()
        : null,
  };
}
