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

  /**
   * After the api changed the profile: re-reads the Firebase user, so user()
   * shows it now and a later token refresh doesn't bring back the old one.
   * If the re-read fails, user() still shows what the api saved.
   */
  async refreshProfile(saved: {
    displayName: string | null;
    photoURL: string | null;
  }): Promise<void> {
    const user = (await this.auth()).currentUser;
    if (!user) return;
    try {
      await user.reload();
      this.publish(user);
    } catch {
      this.state.update((current) =>
        current?.uid === user.uid ? { ...current, ...saved } : current,
      );
    }
  }

  /**
   * Proves it's still the account holder (the api wants a fresh sign-in
   * before deleting the account): the new ID token carries a new
   * `auth_time`, and the interceptor sends it from the next request on.
   */
  async reauthenticateWithPassword(password: string): Promise<void> {
    const { mod, auth } = await this.module();
    const user = auth.currentUser;
    if (!user?.email) throw new Error('No password account is signed in');
    const credential = mod.EmailAuthProvider.credential(user.email, password);
    await mod.reauthenticateWithCredential(user, credential);
    await user.getIdToken(true);
  }

  /** Like signInWithGoogle: the popup opens within the click when loaded. */
  reauthenticateWithGoogle(): Promise<void> {
    const run = async ({ mod, auth }: { auth: Auth; mod: AuthModule }) => {
      const user = auth.currentUser;
      if (!user) throw new Error('Not signed in');
      const provider = new mod.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      // Nothing awaited before this line: the popup opens within the click.
      await mod.reauthenticateWithPopup(user, provider);
      await user.getIdToken(true);
    };
    if (this.loaded) return run(this.loaded);
    return this.module().then(run);
  }

  /**
   * After a failed or lost delete: true only when Firebase says the account
   * no longer exists (it was deleted after all); false for anything else
   * (a revoked session, a network error, an unclear answer).
   *
   * It asks the Identity Toolkit api directly rather than through
   * `user.reload()`: the SDK reports a deleted user and a revoked session
   * alike (`auth/user-token-expired`), and signs out on both. The raw
   * answer tells them apart (`USER_NOT_FOUND`).
   */
  async isAccountGone(): Promise<boolean> {
    const user = (await this.auth()).currentUser;
    if (!user) return false;
    let idToken: string;
    try {
      // Cached (deletion needs a sign-in from the last minutes, and ID
      // tokens last an hour), so this doesn't hit the token endpoint.
      idToken = await user.getIdToken();
    } catch {
      return false;
    }
    const { apiKey, authEmulatorUrl } = this.options;
    const origin =
      authEmulatorUrl && this.devMode
        ? `${authEmulatorUrl}/identitytoolkit.googleapis.com`
        : 'https://identitytoolkit.googleapis.com';
    try {
      const res = await fetch(
        `${origin}/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        },
      );
      if (res.ok) return false;
      const body = (await res.json()) as { error?: { message?: unknown } };
      return body.error?.message === 'USER_NOT_FOUND';
    } catch {
      return false;
    }
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
