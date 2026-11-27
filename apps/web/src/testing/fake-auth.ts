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
  readonly isAdmin = computed(() => this.signedIn() && this.role() === 'admin');
  readonly impersonatedBy = signal<string | null>(null);
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
  readonly sendPasswordReset = vi.fn<(email: string) => Promise<void>>(
    async () => undefined,
  );
  readonly resendVerification = vi.fn<() => Promise<void>>(
    async () => undefined,
  );
  readonly reloadUser = vi.fn<() => Promise<SessionUser | null>>(
    async () => this.state() ?? null,
  );
  readonly refreshProfile = vi.fn<
    (saved: {
      displayName: string | null;
      photoURL: string | null;
    }) => Promise<void>
  >(async (saved) => {
    this.state.update((user) => (user ? { ...user, ...saved } : user));
  });
  readonly reauthenticateWithPassword = vi.fn<
    (password: string) => Promise<void>
  >(async () => undefined);
  readonly reauthenticateWithGoogle = vi.fn<() => Promise<void>>(
    async () => undefined,
  );
  /** What isAccountGone() answers (after a delete whose answer was lost). */
  accountGone = false;
  readonly isAccountGone = vi.fn<() => Promise<boolean>>(
    async () => this.accountGone,
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
    return this.state() ? this.role() : null;
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
