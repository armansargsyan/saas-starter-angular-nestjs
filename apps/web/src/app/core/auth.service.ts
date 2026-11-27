import { computed, inject, Injectable, signal } from '@angular/core';
import type { Auth } from 'firebase/auth';
import { FIREBASE_OPTIONS } from './firebase-options';

/** The signed-in user, as the web app needs it. */
export interface SessionUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  emailVerified: boolean;
}

/**
 * Firebase Auth session state. The Firebase SDK is loaded lazily (dynamic
 * import), so it stays out of the initial bundle and the landing page is
 * interactive before it arrives.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly options = inject(FIREBASE_OPTIONS);
  private authPromise: Promise<Auth> | null = null;

  /** `undefined` until Firebase reports the initial state. */
  private readonly state = signal<SessionUser | null | undefined>(undefined);
  readonly user = this.state.asReadonly();
  readonly ready = computed(() => this.state() !== undefined);
  readonly signedIn = computed(() => !!this.state());

  constructor() {
    this.auth().catch(() => undefined); // failure already handled in auth()
  }

  /**
   * The current user's Firebase ID token, or null when signed out, or when
   * the SDK couldn't load (public `/api` calls then still go out, unsigned).
   */
  async idToken(): Promise<string | null> {
    try {
      const auth = await this.auth();
      await auth.authStateReady();
      return (await auth.currentUser?.getIdToken()) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The Firebase Auth instance (loads the SDK on first use). If loading
   * fails (offline, a stale chunk after a deploy), the session counts as
   * signed out and the next call tries again.
   */
  auth(): Promise<Auth> {
    this.authPromise ??= this.load().catch((err: unknown) => {
      this.authPromise = null;
      this.state.set(null);
      console.error('Firebase Auth failed to load', err);
      throw err;
    });
    return this.authPromise;
  }

  private async load(): Promise<Auth> {
    const [{ initializeApp, getApps }, { getAuth, onAuthStateChanged }] =
      await Promise.all([import('firebase/app'), import('firebase/auth')]);
    const app = getApps()[0] ?? initializeApp(this.options);
    const auth = getAuth(app);
    onAuthStateChanged(auth, (user) =>
      this.state.set(
        user
          ? {
              uid: user.uid,
              email: user.email,
              displayName: user.displayName,
              photoURL: user.photoURL,
              emailVerified: user.emailVerified,
            }
          : null,
      ),
    );
    return auth;
  }
}
