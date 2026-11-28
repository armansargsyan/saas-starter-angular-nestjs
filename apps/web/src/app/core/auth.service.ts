import {
  computed,
  inject,
  Injectable,
  InjectionToken,
  isDevMode,
  signal,
} from '@angular/core';
import type { Auth, User } from 'firebase/auth';
import { FIREBASE_OPTIONS } from './firebase-options';

type AuthModule = typeof import('firebase/auth');

/** Whether this is a dev build (the Auth emulator switch is honored only then). */
export const DEV_MODE = new InjectionToken<boolean>('DEV_MODE', {
  factory: () => isDevMode(),
});

/** The signed-in user, as the web app needs it. */
export interface SessionUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  emailVerified: boolean;
  /** Password accounts must verify their email; Google ones are verified. */
  providers: string[];
}

/** Claims the web app reads (the api re-checks everything server-side). */
interface SessionClaims {
  /** Whose token these came from: they apply only while that user is signed in. */
  uid: string | null;
  role: 'user' | 'admin';
  impersonatedBy: string | null;
  /**
   * Start of an impersonated session's window (epoch ms): the api ends it
   * IMPERSONATION_MAX_MINUTES later.
   */
  impersonationStartedAt: number | null;
}

const NO_CLAIMS: SessionClaims = {
  uid: null,
  role: 'user',
  impersonatedBy: null,
  impersonationStartedAt: null,
};

/**
 * Firebase Auth session state and actions. The SDK is loaded lazily, so it
 * stays out of the initial bundle; if it fails to load, the session counts
 * as signed out and the next call retries.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly options = inject(FIREBASE_OPTIONS);
  private readonly devMode = inject(DEV_MODE);
  private authPromise: Promise<Auth> | null = null;
  /** Kept once loaded, so the Google popup can open within the click's user gesture. */
  private loaded: { auth: Auth; mod: AuthModule } | null = null;

  /** `undefined` until Firebase reports the initial state. */
  private readonly state = signal<SessionUser | null | undefined>(undefined);
  private readonly claims = signal<SessionClaims>(NO_CLAIMS);
  /** The admin's uid while switching to an impersonated session. */
  private readonly switchingFrom = signal<string | null>(null);

  /**
   * The current user's claims. Until a new user's claims are read, the
   * previous user's never apply (no admin carried over); while switching to
   * an impersonated session, it already counts as impersonated (read-only).
   */
  private readonly session = computed<SessionClaims>(() => {
    const uid = this.state()?.uid ?? null;
    const claims = this.claims();
    if (uid !== null && claims.uid === uid) return claims;
    const from = this.switchingFrom();
    return uid !== null && from !== null
      ? { ...NO_CLAIMS, uid, impersonatedBy: from }
      : NO_CLAIMS;
  });

  readonly user = this.state.asReadonly();
  readonly ready = computed(() => this.state() !== undefined);
  readonly signedIn = computed(() => !!this.state());
  /** UI hint only: admin routes are enforced by the api (never while impersonating). */
  readonly isAdmin = computed(
    () =>
      this.signedIn() &&
      this.session().role === 'admin' &&
      !this.session().impersonatedBy,
  );
  readonly impersonatedBy = computed(() => this.session().impersonatedBy);
  /**
   * Whether the signed-in user's claims have been read. Until then nothing
   * is known about impersonation: UI that must not show in an impersonated
   * session (e.g. the verify-email prompt) waits for this.
   */
  readonly claimsKnown = computed(() => {
    const uid = this.state()?.uid;
    return !!uid && this.session().uid === uid;
  });
  /** The shell adds IMPERSONATION_MAX_MINUTES (kept out of this initial-bundle file). */
  readonly impersonationStartedAt = computed(
    () => this.session().impersonationStartedAt,
  );

  constructor() {
    this.auth().catch(() => undefined); // failure already handled in auth()
  }

  /**
   * Resolves once the initial session state and the signed-in user's claims
   * are known (never rejects), so guarded pages render knowing whether the
   * session is impersonated, even right after a reload.
   */
  async whenReady(): Promise<void> {
    try {
      const auth = await this.auth();
      await auth.authStateReady();
      const user = auth.currentUser;
      if (!user || this.claims().uid === user.uid) return;
      const { claims } = await user.getIdTokenResult();
      if (auth.currentUser?.uid === user.uid) {
        this.claims.set(toSessionClaims(user.uid, claims));
      }
    } catch {
      // Load failure: auth() already set the state to signed out. A failed
      // claims read leaves them unknown (claimsKnown() stays false).
    }
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

  /** The role claim of the current token, read now (null when signed out). */
  async currentRole(): Promise<'user' | 'admin' | null> {
    try {
      const auth = await this.auth();
      await auth.authStateReady();
      const result = await auth.currentUser?.getIdTokenResult();
      if (!result) return null;
      // Like the api: an impersonated session is never admin.
      return result.claims['role'] === 'admin' &&
        !result.claims['impersonatedBy']
        ? 'admin'
        : 'user';
    } catch {
      return null;
    }
  }

  async signInWithEmail(email: string, password: string): Promise<void> {
    const { mod, auth } = await this.module();
    const { user } = await mod.signInWithEmailAndPassword(
      auth,
      email,
      password,
    );
    this.publish(user); // callers read user() next: don't wait for the listener
  }

  /**
   * Creates the account. Once it exists, the display name and verification
   * email are best effort: a failure there (e.g. rate limiting) must not
   * look like a failed sign-up; /verify-email has "Resend".
   */
  async signUpWithEmail(
    email: string,
    password: string,
    displayName: string,
  ): Promise<void> {
    const { mod, auth } = await this.module();
    const { user } = await mod.createUserWithEmailAndPassword(
      auth,
      email,
      password,
    );
    this.publish(user);
    try {
      if (displayName) {
        await mod.updateProfile(user, { displayName });
        this.publish(user);
      }
    } catch {
      // The name can be set later in settings.
    }
    try {
      await mod.sendEmailVerification(user, this.continueUrl('/verify-email'));
    } catch {
      // Resend on /verify-email.
    }
  }

  /**
   * Signs in with a custom token from the api (admin impersonation). This
   * replaces the current session: the admin signs back in afterwards.
   */
  async signInWithCustomToken(token: string): Promise<void> {
    const { mod, auth } = await this.module();
    const from = this.state()?.uid ?? null;
    // Read-only and never admin from the first render of the new session.
    this.switchingFrom.set(from ?? 'unknown');
    try {
      const { user } = await mod.signInWithCustomToken(auth, token);
      try {
        const { claims } = await user.getIdTokenResult();
        this.claims.set(toSessionClaims(user.uid, claims));
      } catch (err) {
        // Signed in, but its claims are unknown: don't leave a session the
        // UI can't mark read-only. If even signing out fails, mark it
        // impersonated (read-only, timed) ourselves. The original error wins.
        try {
          await mod.signOut(auth);
        } catch {
          this.claims.set({
            uid: user.uid,
            role: 'user',
            impersonatedBy: from ?? 'unknown',
            impersonationStartedAt: Date.now(),
          });
        }
        throw err;
      }
      // Signed out meanwhile (the timer, another tab): don't bring it back.
      if (auth.currentUser?.uid === user.uid) this.publish(user);
    } finally {
      this.switchingFrom.set(null);
    }
  }

  /**
   * Opens the Google popup. When the SDK is already loaded, the popup opens
   * synchronously inside the click handler (no await first), so browsers
   * that require a user gesture (Safari) don't block it.
   */
  signInWithGoogle(): Promise<void> {
    if (this.loaded) return this.popup(this.loaded);
    return this.module().then((loaded) => this.popup(loaded));
  }

  /** Always resolves the same way whether or not the account exists. */
  async sendPasswordReset(email: string): Promise<void> {
    const { mod, auth } = await this.module();
    try {
      await mod.sendPasswordResetEmail(auth, email, this.continueUrl('/login'));
    } catch (err) {
      // Don't reveal which emails have accounts.
      if ((err as { code?: string }).code !== 'auth/user-not-found') throw err;
    }
  }

  /**
   * Refused while impersonating: it would email the user as them. Checked
   * on the token itself, not on claims() (which may not be read yet).
   */
  async resendVerification(): Promise<void> {
    if (this.impersonatedBy()) throw readOnlyError();
    const { mod, auth } = await this.module();
    const user = auth.currentUser;
    if (!user) return;
    const { claims } = await user.getIdTokenResult();
    if (claims['impersonatedBy']) throw readOnlyError();
    await mod.sendEmailVerification(user, this.continueUrl('/verify-email'));
  }

  /** Re-reads the user (e.g. after clicking the verification link elsewhere). */
  async reloadUser(): Promise<SessionUser | null> {
    const user = (await this.auth()).currentUser;
    if (!user) return null;
    await user.reload();
    // The token carries email_verified for the api: refresh it too.
    await user.getIdToken(true);
    this.publish(user);
    return this.state() ?? null;
  }

  async signOut(): Promise<void> {
    const { mod, auth } = await this.module();
    await mod.signOut(auth);
  }

  /** The Firebase Auth instance (loads the SDK on first use). */
  auth(): Promise<Auth> {
    this.authPromise ??= this.load().catch((err: unknown) => {
      this.authPromise = null;
      this.state.set(null);
      console.error('Firebase Auth failed to load', err);
      throw err;
    });
    return this.authPromise;
  }

  private async module(): Promise<{ auth: Auth; mod: AuthModule }> {
    await this.auth();
    if (!this.loaded) throw new Error('Firebase Auth is not available');
    return this.loaded;
  }

  private async popup({ mod, auth }: { auth: Auth; mod: AuthModule }) {
    const provider = new mod.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const { user } = await mod.signInWithPopup(auth, provider);
    this.publish(user);
  }

  private async load(): Promise<Auth> {
    const [{ initializeApp, getApps }, mod] = await Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
    ]);
    const { authEmulatorUrl, ...options } = this.options;
    const app = getApps()[0] ?? initializeApp(options);
    const auth = mod.getAuth(app);
    if (authEmulatorUrl && this.devMode) {
      mod.connectAuthEmulator(auth, authEmulatorUrl, { disableWarnings: true });
    }
    // Fires on sign-in/out and on token refresh (new claims, e.g. a role change).
    mod.onIdTokenChanged(auth, (user) => {
      this.publish(user);
      if (!user) {
        this.claims.set(NO_CLAIMS);
        return;
      }
      user
        .getIdTokenResult()
        .then(({ claims }) => {
          // A late result from a previous session must not leak into this one.
          if (auth.currentUser?.uid !== user.uid) return;
          this.claims.set(toSessionClaims(user.uid, claims));
        })
        // Fail closed: keep what's known. This user's earlier claims (e.g.
        // impersonated) stay; another user's never apply (session() is keyed
        // by uid), so nothing needs resetting.
        .catch(() => undefined);
    });
    this.loaded = { auth, mod };
    return auth;
  }

  private publish(user: User | null): void {
    this.state.set(
      user
        ? {
            uid: user.uid,
            email: user.email,
            displayName: user.displayName,
            photoURL: user.photoURL,
            emailVerified: user.emailVerified,
            providers: user.providerData.map((p) => p.providerId),
          }
        : null,
    );
  }

  /** Where Firebase's emailed links send the user back to. */
  private continueUrl(path: string) {
    return { url: `${location.origin}${path}` };
  }
}

function toSessionClaims(
  uid: string,
  claims: Record<string, unknown>,
): SessionClaims {
  const impersonatedBy =
    typeof claims['impersonatedBy'] === 'string' && claims['impersonatedBy']
      ? claims['impersonatedBy']
      : null;
  return {
    uid,
    role: claims['role'] === 'admin' ? 'admin' : 'user',
    impersonatedBy,
    impersonationStartedAt: impersonatedBy
      ? impersonationStart(claims['impersonatedAt'], claims['auth_time'])
      : null,
  };
}

/** Same `code` shape as Firebase errors, for authErrorMessage. */
function readOnlyError(): Error {
  return Object.assign(new Error('Impersonated sessions are read-only'), {
    code: 'app/impersonation-read-only',
  });
}

/**
 * Mirrors the api guard: the window runs from minting and from sign-in,
 * whichever ends first, so it starts at the earlier of the two. An unknown
 * minting time counts as long ago (the api rejects such a session).
 */
export function impersonationStart(
  impersonatedAt: unknown,
  authTime: unknown,
): number {
  const minted = Number(impersonatedAt);
  if (typeof impersonatedAt !== 'string' || !Number.isFinite(minted)) return 0;
  const signedIn = Number(authTime) * 1000;
  return Number.isFinite(signedIn) ? Math.min(minted, signedIn) : minted;
}
