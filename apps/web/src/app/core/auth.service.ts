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
  role: 'user' | 'admin';
  impersonatedBy: string | null;
}

const NO_CLAIMS: SessionClaims = { role: 'user', impersonatedBy: null };

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

  readonly user = this.state.asReadonly();
  readonly ready = computed(() => this.state() !== undefined);
  readonly signedIn = computed(() => !!this.state());
  /** UI hint only: admin routes are enforced by the api. */
  readonly isAdmin = computed(
    () => this.signedIn() && this.claims().role === 'admin',
  );
  readonly impersonatedBy = computed(() => this.claims().impersonatedBy);

  constructor() {
    this.auth().catch(() => undefined); // failure already handled in auth()
  }

  /** Resolves once the initial session state is known (never rejects). */
  async whenReady(): Promise<void> {
    try {
      await (await this.auth()).authStateReady();
    } catch {
      // Load failure: auth() already set the state to signed out.
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
      return result.claims['role'] === 'admin' ? 'admin' : 'user';
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

  async resendVerification(): Promise<void> {
    const { mod, auth } = await this.module();
    if (auth.currentUser) {
      await mod.sendEmailVerification(
        auth.currentUser,
        this.continueUrl('/verify-email'),
      );
    }
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
          this.claims.set({
            role: claims['role'] === 'admin' ? 'admin' : 'user',
            impersonatedBy:
              typeof claims['impersonatedBy'] === 'string'
                ? claims['impersonatedBy']
                : null,
          });
        })
        .catch(() => this.claims.set(NO_CLAIMS));
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
