import { computed, signal } from '@angular/core';
import type { AuthService, SessionUser } from '../app/core/auth.service';

/** Controllable stand-in for AuthService (no Firebase in unit tests). */
export class FakeAuth {
  readonly state = signal<SessionUser | null | undefined>(null);
  readonly user = this.state.asReadonly();
  readonly ready = computed(() => this.state() !== undefined);
  readonly signedIn = computed(() => !!this.state());
  token: string | null = 'test-token';

  async idToken(): Promise<string | null> {
    return this.state() ? this.token : null;
  }

  signIn(uid = 'u1'): void {
    this.state.set({
      uid,
      email: `${uid}@example.com`,
      displayName: null,
      photoURL: null,
      emailVerified: true,
    });
  }

  signOut(): void {
    this.state.set(null);
  }
}

export const asAuthService = (fake: FakeAuth) => fake as unknown as AuthService;
