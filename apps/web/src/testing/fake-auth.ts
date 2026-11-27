import { computed, signal } from '@angular/core';
import type { AuthService, SessionUser } from '../app/core/auth.service';

/**
 * Controllable stand-in for AuthService (no Firebase in unit tests). Test
 * helpers: signIn()/setSignedOut(); the actions are vi.fn spies.
 */
export class FakeAuth {
  readonly state = signal<SessionUser | null | undefined>(null);
  readonly user = this.state.asReadonly();
  readonly ready = computed(() => this.state() !== undefined);
  readonly signedIn = computed(() => !!this.state());
  readonly role = signal<'user' | 'admin'>('user');
  readonly impersonatedBy = signal<string | null>(null);
  readonly impersonationStartedAt = signal<number | null>(null);
  /** Set false to model a session whose claims aren't read yet. */
  readonly claimsRead = signal(true);
  readonly claimsKnown = computed(() => this.signedIn() && this.claimsRead());
  readonly isAdmin = computed(
    () => this.signedIn() && this.role() === 'admin' && !this.impersonatedBy(),
  );
  token: string | null = 'test-token';

  readonly signInWithEmail = vi.fn<
    (email: string, password: string) => Promise<void>
  >(async () => this.signIn());
  readonly signUpWithEmail = vi.fn<
    (email: string, password: string, name: string) => Promise<void>
  >(async () =>
    this.signIn('u1', { emailVerified: false, providers: ['password'] }),
  );
  readonly signInWithGoogle = vi.fn<() => Promise<void>>(async () =>
    this.signIn(),
  );
  /** Like the real one: the new session is impersonated by the previous user. */
  readonly signInWithCustomToken = vi.fn<(token: string) => Promise<void>>(
    async () => {
      this.impersonatedBy.set(this.state()?.uid ?? 'unknown');
      this.signIn('impersonated');
    },
  );
  readonly sendPasswordReset = vi.fn<(email: string) => Promise<void>>(
    async () => undefined,
  );
  readonly resendVerification = vi.fn<() => Promise<void>>(
    async () => undefined,
  );
  readonly reloadUser = vi.fn<() => Promise<SessionUser | null>>(
    async () => this.state() ?? null,
  );
  readonly signOut = vi.fn<() => Promise<void>>(async () =>
    this.setSignedOut(),
  );

  async whenReady(): Promise<void> {
    return undefined;
  }

  async idToken(): Promise<string | null> {
    return this.state() ? this.token : null;
  }

  async currentRole(): Promise<'user' | 'admin' | null> {
    // Like the real one: never admin while impersonating.
    if (!this.state()) return null;
    return this.isAdmin() ? 'admin' : 'user';
  }

  signIn(uid = 'u1', overrides: Partial<SessionUser> = {}): void {
    this.state.set({
      uid,
      email: `${uid}@example.com`,
      displayName: null,
      photoURL: null,
      emailVerified: true,
      providers: ['google.com'],
      ...overrides,
    });
  }

  setSignedOut(): void {
    this.state.set(null);
  }
}

export const asAuthService = (fake: FakeAuth) => fake as unknown as AuthService;
