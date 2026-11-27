import { TestBed } from '@angular/core/testing';
import { settle } from '../../testing/settle';
import { AuthService, DEV_MODE } from './auth.service';
import { FIREBASE_OPTIONS, type FirebaseOptions } from './firebase-options';

// A small fake of the Firebase Auth module.
const fb = vi.hoisted(() => {
  type Listener = (user: unknown) => void;
  const state = {
    failNextInit: false,
    currentUser: null as null | Record<string, unknown>,
    listener: null as Listener | null,
    claims: {} as Record<string, unknown>,
  };
  const makeUser = (overrides: Record<string, unknown> = {}) => ({
    uid: 'u1',
    email: 'ada@example.com',
    displayName: null,
    photoURL: null,
    emailVerified: false,
    providerData: [{ providerId: 'password' }],
    reload: vi.fn(async () => undefined),
    getIdToken: vi.fn(async () => 'token'),
    getIdTokenResult: vi.fn(async () => ({ claims: state.claims })),
    ...overrides,
  });
  const auth = {
    get currentUser() {
      return state.currentUser;
    },
    authStateReady: vi.fn(async () => undefined),
  };
  const emit = (user: Record<string, unknown> | null) => {
    state.currentUser = user;
    state.listener?.(user);
  };
  return {
    state,
    auth,
    makeUser,
    emit,
    mod: {
      getAuth: vi.fn(() => auth),
      connectAuthEmulator: vi.fn(),
      onIdTokenChanged: vi.fn((_a: unknown, cb: Listener) => {
        state.listener = cb;
        cb(state.currentUser);
      }),
      signInWithEmailAndPassword: vi.fn(async () => {
        const user = makeUser({ emailVerified: true });
        state.currentUser = user; // the listener fires later, on purpose
        return { user };
      }),
      createUserWithEmailAndPassword: vi.fn(async () => {
        const user = makeUser();
        state.currentUser = user;
        return { user };
      }),
      updateProfile: vi.fn(async () => undefined),
      sendEmailVerification: vi.fn(async () => undefined),
      sendPasswordResetEmail: vi.fn(async () => undefined),
      signInWithPopup: vi.fn(async () => {
        const user = makeUser({
          emailVerified: true,
          providerData: [{ providerId: 'google.com' }],
        });
        state.currentUser = user;
        return { user };
      }),
      GoogleAuthProvider: class {
        setCustomParameters = vi.fn();
      },
      signOut: vi.fn(async () => emit(null)),
    },
  };
});

vi.mock('firebase/app', () => ({
  getApps: () => [],
  initializeApp: () => {
    if (fb.state.failNextInit) {
      fb.state.failNextInit = false;
      throw new Error('init failed');
    }
    return {};
  },
}));
vi.mock('firebase/auth', () => fb.mod);

const OPTIONS: FirebaseOptions = {
  apiKey: 'k',
  authDomain: 'd',
  projectId: 'p',
  appId: 'a',
};

function create(options: FirebaseOptions = OPTIONS, devMode = true) {
  TestBed.configureTestingModule({
    providers: [
      { provide: FIREBASE_OPTIONS, useValue: options },
      { provide: DEV_MODE, useValue: devMode },
    ],
  });
  return TestBed.inject(AuthService);
}

describe('AuthService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fb.state.currentUser = null;
    fb.state.claims = {};
    fb.state.failNextInit = false;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('treats a failed SDK load as signed out, answers null tokens, and retries', async () => {
    fb.state.failNextInit = true;
    const auth = create();
    await settle();

    expect(auth.ready()).toBe(true);
    expect(auth.signedIn()).toBe(false);
    expect(await auth.idToken()).toBeNull();
    await expect(auth.auth()).resolves.toBeDefined();
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('connects to the Auth emulator only in dev mode', async () => {
    create({ ...OPTIONS, authEmulatorUrl: 'http://127.0.0.1:9099' });
    await settle();
    expect(fb.mod.connectAuthEmulator).toHaveBeenCalledWith(
      fb.auth,
      'http://127.0.0.1:9099',
      { disableWarnings: true },
    );

    TestBed.resetTestingModule();
    vi.clearAllMocks();
    create({ ...OPTIONS, authEmulatorUrl: 'http://127.0.0.1:9099' }, false);
    await settle();
    expect(fb.mod.connectAuthEmulator).not.toHaveBeenCalled();
  });

  it('publishes the user right after email or Google sign-in', async () => {
    const auth = create();
    await settle();

    await auth.signInWithEmail('ada@example.com', 'pw');
    expect(auth.user()?.uid).toBe('u1');

    fb.emit(null);
    await auth.signInWithGoogle();
    expect(auth.user()?.providers).toEqual(['google.com']);
  });

  it('opens the Google popup without awaiting first once loaded (user gesture)', async () => {
    const auth = create();
    await settle();
    void auth.signInWithGoogle();
    // Synchronously, before any microtask: the popup call already happened.
    expect(fb.mod.signInWithPopup).toHaveBeenCalledTimes(1);
  });

  it('keeps a new account even if the name or verification email fails', async () => {
    fb.mod.updateProfile.mockRejectedValueOnce(new Error('nope'));
    fb.mod.sendEmailVerification.mockRejectedValueOnce({
      code: 'auth/too-many-requests',
    });
    const auth = create();
    await settle();

    await expect(
      auth.signUpWithEmail('ada@example.com', 'pw', 'Ada'),
    ).resolves.toBeUndefined();
    expect(auth.user()?.uid).toBe('u1');
    expect(fb.mod.sendEmailVerification).toHaveBeenCalledWith(
      expect.anything(),
      { url: `${location.origin}/verify-email` },
    );
  });

  it('does not reveal unknown accounts on password reset, but reports other errors', async () => {
    const auth = create();
    await settle();
    fb.mod.sendPasswordResetEmail.mockRejectedValueOnce({
      code: 'auth/user-not-found',
    });
    await expect(
      auth.sendPasswordReset('nobody@example.com'),
    ).resolves.toBeUndefined();

    fb.mod.sendPasswordResetEmail.mockRejectedValueOnce({
      code: 'auth/too-many-requests',
    });
    await expect(auth.sendPasswordReset('ada@example.com')).rejects.toEqual({
      code: 'auth/too-many-requests',
    });
  });

  it('reloads the user and forces a token refresh (email_verified for the api)', async () => {
    const auth = create();
    await settle();
    const user = fb.makeUser({ emailVerified: true });
    fb.emit(user);

    const reloaded = await auth.reloadUser();

    expect(user.reload).toHaveBeenCalled();
    expect(user.getIdToken).toHaveBeenCalledWith(true);
    expect(reloaded?.emailVerified).toBe(true);
  });

  it('maps role and impersonation claims, ignoring a stale result', async () => {
    const auth = create();
    await settle();
    expect(await auth.currentRole()).toBeNull();

    fb.state.claims = { role: 'admin', impersonatedBy: 'admin-9' };
    fb.emit(fb.makeUser());
    await settle();
    expect(auth.isAdmin()).toBe(true);
    expect(auth.impersonatedBy()).toBe('admin-9');
    expect(await auth.currentRole()).toBe('admin');

    // A slow claims result for the previous user arrives after a switch.
    let resolveOld: (v: unknown) => void = () => undefined;
    const old = fb.makeUser({
      uid: 'old',
      getIdTokenResult: vi.fn(() => new Promise((r) => (resolveOld = r))),
    });
    fb.emit(old);
    fb.state.claims = {};
    fb.emit(fb.makeUser({ uid: 'new' }));
    await settle();
    resolveOld({ claims: { role: 'admin' } });
    await settle();
    expect(auth.user()?.uid).toBe('new');
    expect(auth.isAdmin()).toBe(false);
  });
});
