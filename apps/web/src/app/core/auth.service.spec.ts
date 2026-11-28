import { TestBed } from '@angular/core/testing';
import { settle } from '../../testing/settle';
import { AuthService, DEV_MODE, impersonationStart } from './auth.service';
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
      signInWithCustomToken: vi.fn(async () => {
        const user = makeUser({ uid: 'target', providerData: [] });
        state.currentUser = user;
        return { user };
      }),
      signOut: vi.fn(async () => emit(null)),
      EmailAuthProvider: {
        credential: vi.fn((email: string, password: string) => ({
          email,
          password,
        })),
      },
      reauthenticateWithCredential: vi.fn(async () => undefined),
      reauthenticateWithPopup: vi.fn(async () => undefined),
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

  it('re-reads the user after a profile change, so user() shows it', async () => {
    const auth = create();
    await settle();
    const user = fb.makeUser();
    user.reload.mockImplementation(async () => {
      Object.assign(user, { displayName: 'Ada', photoURL: 'https://a/b.png' });
    });
    fb.emit(user);

    await auth.refreshProfile({ displayName: 'Ada', photoURL: null });

    expect(user.reload).toHaveBeenCalled();
    expect(auth.user()).toMatchObject({
      displayName: 'Ada',
      photoURL: 'https://a/b.png',
    });
  });

  it('shows what the api saved when the re-read fails', async () => {
    const auth = create();
    await settle();
    const user = fb.makeUser();
    user.reload.mockRejectedValue(new Error('offline'));
    fb.emit(user);

    await auth.refreshProfile({ displayName: 'Ada', photoURL: null });

    expect(auth.user()).toMatchObject({ displayName: 'Ada', photoURL: null });
  });

  it('re-authenticates a password account and refreshes the token', async () => {
    const auth = create();
    await settle();
    const user = fb.makeUser();
    fb.emit(user);

    await auth.reauthenticateWithPassword('secret-pw');

    expect(fb.mod.EmailAuthProvider.credential).toHaveBeenCalledWith(
      'ada@example.com',
      'secret-pw',
    );
    expect(fb.mod.reauthenticateWithCredential).toHaveBeenCalledWith(user, {
      email: 'ada@example.com',
      password: 'secret-pw',
    });
    expect(user.getIdToken).toHaveBeenCalledWith(true);
  });

  it('re-authenticates with Google, opening the popup within the click once loaded', async () => {
    const auth = create();
    await settle();
    const user = fb.makeUser({ providerData: [{ providerId: 'google.com' }] });
    fb.emit(user);

    const done = auth.reauthenticateWithGoogle();
    // Synchronously, before any await: browsers keep the user gesture.
    expect(fb.mod.reauthenticateWithPopup).toHaveBeenCalledTimes(1);
    await done;
    expect(user.getIdToken).toHaveBeenCalledWith(true);
  });

  it('passes re-authentication errors on (e.g. a wrong password)', async () => {
    const auth = create();
    await settle();
    fb.emit(fb.makeUser());
    fb.mod.reauthenticateWithCredential.mockRejectedValueOnce({
      code: 'auth/invalid-credential',
    });
    await expect(auth.reauthenticateWithPassword('nope')).rejects.toEqual({
      code: 'auth/invalid-credential',
    });
  });

  describe('isAccountGone', () => {
    const answer = (status: number, body: unknown) =>
      vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify(body), { status }));

    async function signedIn(devMode = true) {
      const auth = create(
        { ...OPTIONS, authEmulatorUrl: 'http://127.0.0.1:9099' },
        devMode,
      );
      await settle();
      const user = fb.makeUser();
      fb.emit(user);
      return { auth, user };
    }

    afterEach(() => vi.restoreAllMocks());

    it('is true only for USER_NOT_FOUND, asked with the current ID token', async () => {
      const { auth } = await signedIn();
      const fetch = answer(400, { error: { message: 'USER_NOT_FOUND' } });

      expect(await auth.isAccountGone()).toBe(true);
      expect(fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:lookup?key=k',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ idToken: 'token' }),
        }),
      );
    });

    it('talks to the real api outside dev mode', async () => {
      const { auth } = await signedIn(false);
      const fetch = answer(400, { error: { message: 'USER_NOT_FOUND' } });
      await auth.isAccountGone();
      expect(fetch.mock.calls[0][0]).toBe(
        'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=k',
      );
    });

    it.each([
      ['the account exists', 200, { users: [{ localId: 'u1' }] }],
      ['the session was revoked', 400, { error: { message: 'TOKEN_EXPIRED' } }],
      ['the token is invalid', 400, { error: { message: 'INVALID_ID_TOKEN' } }],
      ['the user is disabled', 400, { error: { message: 'USER_DISABLED' } }],
    ])('is false when %s', async (_, status, body) => {
      const { auth } = await signedIn();
      answer(status, body);
      expect(await auth.isAccountGone()).toBe(false);
    });

    it('is false on a network error, a token it cannot get, or no user', async () => {
      const { auth, user } = await signedIn();
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
      expect(await auth.isAccountGone()).toBe(false);

      user.getIdToken.mockRejectedValueOnce({
        code: 'auth/user-token-expired',
      });
      expect(await auth.isAccountGone()).toBe(false);

      fb.emit(null);
      expect(await auth.isAccountGone()).toBe(false);
    });
  });

  it('maps role and impersonation claims, ignoring a stale result', async () => {
    const auth = create();
    await settle();
    expect(await auth.currentRole()).toBeNull();

    fb.state.claims = { role: 'admin' };
    fb.emit(fb.makeUser());
    await settle();
    expect(auth.isAdmin()).toBe(true);
    expect(auth.impersonatedBy()).toBeNull();
    expect(auth.impersonationStartedAt()).toBeNull();
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

  it('signs in with an impersonation token and reads the session window', async () => {
    const auth = create();
    await settle();
    const minted = Date.UTC(2026, 10, 27, 12, 0);
    await auth.signInWithCustomToken('custom-token');
    expect(fb.mod.signInWithCustomToken).toHaveBeenCalledWith(
      fb.auth,
      'custom-token',
    );
    expect(auth.user()?.uid).toBe('target');

    fb.state.claims = {
      // Even a (stale) admin claim never makes an impersonated session admin.
      role: 'admin',
      impersonatedBy: 'admin-9',
      impersonatedAt: String(minted),
      auth_time: String(minted / 1000 + 60),
    };
    fb.emit(fb.state.currentUser);
    await settle();
    expect(auth.impersonatedBy()).toBe('admin-9');
    expect(auth.isAdmin()).toBe(false);
    expect(await auth.currentRole()).toBe('user');
    expect(auth.impersonationStartedAt()).toBe(minted);
  });

  it('starts the impersonation window at the earlier of minting and sign-in', () => {
    expect(impersonationStart('1000000', '500')).toBe(500_000);
    expect(impersonationStart('1000000', '5000')).toBe(1_000_000);
    expect(impersonationStart('1000000', undefined)).toBe(1_000_000);
    expect(impersonationStart(undefined, '500')).toBe(0);
    expect(impersonationStart('nope', '500')).toBe(0);
  });

  describe('impersonating from an admin session', () => {
    const minted = Date.UTC(2026, 10, 27, 12, 0);
    const targetClaims = {
      impersonatedBy: 'admin-uid',
      impersonatedAt: String(minted),
      auth_time: String(minted / 1000),
    };

    /** Signed in as an admin, with the admin claim read. */
    async function asAdmin() {
      const auth = create();
      await settle();
      fb.state.claims = { role: 'admin' };
      fb.emit(fb.makeUser({ uid: 'admin-uid' }));
      await settle();
      expect(auth.isAdmin()).toBe(true);
      return auth;
    }

    it('is read-only and never admin from the moment the user switches', async () => {
      const auth = await asAdmin();
      let resolveClaims: (v: unknown) => void = () => undefined;
      const target = fb.makeUser({
        uid: 'target',
        getIdTokenResult: vi.fn(() => new Promise((r) => (resolveClaims = r))),
      });
      // Like Firebase: listeners hear about the new user before sign-in resolves.
      fb.mod.signInWithCustomToken.mockImplementationOnce(async () => {
        fb.emit(target);
        return { user: target };
      });

      const done = auth.signInWithCustomToken('custom-token');
      await settle();
      // The admin's claims don't carry over while the target's are read.
      expect(auth.user()?.uid).toBe('target');
      expect(auth.isAdmin()).toBe(false);
      expect(auth.impersonatedBy()).toBe('admin-uid');

      resolveClaims({ claims: targetClaims });
      await done;
      await settle();
      expect(auth.user()?.uid).toBe('target');
      expect(auth.isAdmin()).toBe(false);
      expect(auth.impersonatedBy()).toBe('admin-uid');
      expect(auth.impersonationStartedAt()).toBe(minted);
      expect(fb.mod.signOut).not.toHaveBeenCalled();
    });

    it('signs out when the new session’s claims can’t be read', async () => {
      const auth = await asAdmin();
      const target = fb.makeUser({
        uid: 'target',
        getIdTokenResult: vi.fn(async () => {
          throw new Error('network');
        }),
      });
      fb.mod.signInWithCustomToken.mockImplementationOnce(async () => {
        fb.emit(target);
        return { user: target };
      });
      await expect(auth.signInWithCustomToken('t')).rejects.toThrow('network');
      expect(fb.mod.signOut).toHaveBeenCalled();
      expect(auth.signedIn()).toBe(false);
    });

    it('refuses to resend the verification email as the user', async () => {
      const auth = create();
      await settle();
      fb.state.claims = targetClaims;
      fb.emit(fb.makeUser({ uid: 'target' }));
      await settle();
      expect(auth.impersonatedBy()).toBe('admin-uid');
      await expect(auth.resendVerification()).rejects.toMatchObject({
        code: 'app/impersonation-read-only',
      });
      expect(fb.mod.sendEmailVerification).not.toHaveBeenCalled();
    });
  });

  describe('impersonated sessions fail closed', () => {
    const minted = Date.UTC(2026, 10, 27, 12, 0);
    const targetClaims = {
      impersonatedBy: 'admin-uid',
      impersonatedAt: String(minted),
      auth_time: String(minted / 1000),
    };
    const deferred = () => {
      let resolve: (v: unknown) => void = () => undefined;
      let reject: (e: unknown) => void = () => undefined;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };

    it('keeps a session impersonated when a later claims read fails', async () => {
      const auth = create();
      await settle();
      fb.state.claims = targetClaims;
      fb.emit(fb.makeUser({ uid: 'target' }));
      await settle();
      expect(auth.impersonatedBy()).toBe('admin-uid');

      // A token refresh whose claims can't be read.
      fb.emit(
        fb.makeUser({
          uid: 'target',
          getIdTokenResult: vi.fn(async () => {
            throw new Error('network');
          }),
        }),
      );
      await settle();
      expect(auth.impersonatedBy()).toBe('admin-uid');
      expect(auth.claimsKnown()).toBe(true);
      expect(auth.impersonationStartedAt()).toBe(minted);
    });

    it('ignores a late failure from an earlier user', async () => {
      const auth = create();
      await settle();
      const old = deferred();
      fb.emit(
        fb.makeUser({ uid: 'old', getIdTokenResult: vi.fn(() => old.promise) }),
      );
      fb.state.claims = targetClaims;
      fb.emit(fb.makeUser({ uid: 'target' }));
      await settle();
      old.reject(new Error('late'));
      await settle();
      expect(auth.impersonatedBy()).toBe('admin-uid');
    });

    it('after a reload, knows the session is impersonated before whenReady resolves', async () => {
      const claims = deferred();
      // The persisted impersonated session, restored on load.
      fb.state.currentUser = fb.makeUser({
        uid: 'target',
        emailVerified: false,
        getIdTokenResult: vi.fn(() => claims.promise),
      });
      const auth = create();
      let ready = false;
      const whenReady = auth.whenReady().then(() => (ready = true));
      await settle();
      // Signed in, claims unknown: not admin, and the UI is told to wait.
      expect(auth.user()?.uid).toBe('target');
      expect(auth.claimsKnown()).toBe(false);
      expect(auth.isAdmin()).toBe(false);
      expect(ready).toBe(false);
      // Resend checks the token itself, so it can't slip through meanwhile.
      const resend = auth.resendVerification();

      claims.resolve({ claims: targetClaims });
      await whenReady;
      expect(auth.claimsKnown()).toBe(true);
      expect(auth.impersonatedBy()).toBe('admin-uid');
      await expect(resend).rejects.toMatchObject({
        code: 'app/impersonation-read-only',
      });
      expect(fb.mod.sendEmailVerification).not.toHaveBeenCalled();
    });

    it('resends for a normal session (claims read from the token)', async () => {
      const auth = create();
      await settle();
      fb.emit(fb.makeUser());
      await settle();
      await auth.resendVerification();
      expect(fb.mod.sendEmailVerification).toHaveBeenCalled();
    });

    it('keeps the original error, and marks the session, when signing out fails too', async () => {
      const auth = create();
      await settle();
      fb.state.claims = { role: 'admin' };
      fb.emit(fb.makeUser({ uid: 'admin-uid' }));
      await settle();
      const target = fb.makeUser({
        uid: 'target',
        getIdTokenResult: vi.fn(async () => {
          throw new Error('network');
        }),
      });
      fb.mod.signInWithCustomToken.mockImplementationOnce(async () => {
        fb.emit(target);
        return { user: target };
      });
      fb.mod.signOut.mockRejectedValueOnce(new Error('offline'));

      await expect(auth.signInWithCustomToken('t')).rejects.toThrow('network');
      await settle();
      expect(auth.user()?.uid).toBe('target');
      expect(auth.isAdmin()).toBe(false);
      expect(auth.impersonatedBy()).toBe('admin-uid');
      expect(auth.impersonationStartedAt()).toEqual(expect.any(Number));
    });

    it('doesn’t bring back a session signed out while its claims were read', async () => {
      const auth = create();
      await settle();
      fb.emit(fb.makeUser({ uid: 'admin-uid' }));
      await settle();
      const claims = deferred();
      const target = fb.makeUser({
        uid: 'target',
        getIdTokenResult: vi.fn(() => claims.promise),
      });
      fb.mod.signInWithCustomToken.mockImplementationOnce(async () => {
        fb.state.currentUser = target;
        return { user: target };
      });
      const done = auth.signInWithCustomToken('t');
      await settle();
      fb.emit(null); // e.g. signed out in another tab
      claims.resolve({ claims: targetClaims });
      await done;
      expect(auth.signedIn()).toBe(false);
    });
  });
});
