import { TestBed } from '@angular/core/testing';
import { settle } from '../../testing/settle';
import { AuthService } from './auth.service';
import { FIREBASE_OPTIONS } from './firebase-options';

// Firebase initialization fails the first time, then works. It goes through
// the same recovery path as a failed dynamic import (e.g. a stale chunk).
let failNextLoad = true;
vi.mock('firebase/app', () => ({
  getApps: () => [],
  initializeApp: () => {
    if (failNextLoad) {
      failNextLoad = false;
      throw new Error('chunk failed');
    }
    return {};
  },
}));
vi.mock('firebase/auth', () => ({
  getAuth: () => ({ authStateReady: async () => undefined, currentUser: null }),
  onAuthStateChanged: (_auth: unknown, cb: (user: null) => void) => cb(null),
}));

describe('AuthService', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: FIREBASE_OPTIONS,
          useValue: {
            apiKey: 'k',
            authDomain: 'd',
            projectId: 'p',
            appId: 'a',
          },
        },
      ],
    });
  });

  it('treats a failed SDK load as signed out, answers null tokens, and retries', async () => {
    const auth = TestBed.inject(AuthService);
    await settle();

    expect(auth.ready()).toBe(true);
    expect(auth.signedIn()).toBe(false);
    // Retries the load; no token either way, and no hang.
    expect(await auth.idToken()).toBeNull();
    await expect(auth.auth()).resolves.toBeDefined();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
