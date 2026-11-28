import { describe, expect, it, vi } from 'vitest';
import type { Auth } from 'firebase-admin/auth';
import { FirebaseIdentityProvider } from './identity.provider';

function provider(auth: Partial<Record<keyof Auth, unknown>>) {
  return new FirebaseIdentityProvider(auth as unknown as Auth);
}

describe('FirebaseIdentityProvider', () => {
  describe('verifyIdToken', () => {
    it('checks revocation and maps the claims it needs', async () => {
      const verifyIdToken = vi.fn().mockResolvedValue({
        uid: 'u1',
        email: 'a@example.com',
        email_verified: true,
        iat: 1_780_000_000,
        auth_time: 1_779_999_000,
        role: 'admin',
      });

      const token = await provider({ verifyIdToken }).verifyIdToken('tok');

      expect(verifyIdToken).toHaveBeenCalledWith('tok', true);
      expect(token).toEqual({
        uid: 'u1',
        email: 'a@example.com',
        emailVerified: true,
        issuedAt: new Date(1_780_000_000 * 1000),
        authTime: new Date(1_779_999_000 * 1000),
        impersonatedBy: null,
        impersonatedAt: null,
        role: 'admin',
      });
    });

    it('carries the impersonating admin from the custom-token claim', async () => {
      const verifyIdToken = vi.fn().mockResolvedValue({
        uid: 'u1',
        iat: 0,
        auth_time: 0,
        impersonatedBy: 'admin-1',
        impersonatedAt: '1780000000000',
      });
      const token = await provider({ verifyIdToken }).verifyIdToken('tok');
      expect(token.impersonatedBy).toBe('admin-1');
      expect(token.impersonatedAt).toEqual(new Date(1_780_000_000_000));
    });

    it.each([undefined, false, 'true'])(
      'treats email_verified=%j as unverified',
      async (emailVerified) => {
        const verifyIdToken = vi.fn().mockResolvedValue({
          uid: 'u1',
          iat: 0,
          email_verified: emailVerified,
        });

        const token = await provider({ verifyIdToken }).verifyIdToken('tok');

        expect(token.emailVerified).toBe(false);
      },
    );
  });

  describe('getUser', () => {
    it('maps the user record', async () => {
      const getUser = vi
        .fn()
        .mockResolvedValue({ uid: 'u1', email: 'a@example.com' });

      expect(await provider({ getUser }).getUser('u1')).toEqual({
        uid: 'u1',
        email: 'a@example.com',
        displayName: null,
        photoURL: null,
        disabled: false,
        role: 'user',
      });
    });

    it('returns null when the user does not exist', async () => {
      const getUser = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('gone'), { code: 'auth/user-not-found' }),
        );

      expect(await provider({ getUser }).getUser('u1')).toBeNull();
    });

    it('rethrows any other error', async () => {
      const getUser = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('down'), { code: 'auth/internal-error' }),
        );

      await expect(provider({ getUser }).getUser('u1')).rejects.toThrow('down');
    });
  });
});

describe('admin operations', () => {
  it('bans, revokes sessions and mints impersonation tokens through the Admin SDK', async () => {
    const auth = {
      updateUser: vi.fn().mockResolvedValue({}),
      revokeRefreshTokens: vi.fn().mockResolvedValue(undefined),
      createCustomToken: vi.fn().mockResolvedValue('custom-token'),
      getUser: vi.fn().mockResolvedValue({
        uid: 'u1',
        disabled: true,
        customClaims: { role: 'admin' },
      }),
    };
    const p = provider(auth);

    await p.setDisabled('u1', true);
    await p.revokeSessions('u1');
    expect(await p.createCustomToken('u1', { impersonatedBy: 'a1' })).toBe(
      'custom-token',
    );
    expect(await p.getUser('u1')).toMatchObject({
      disabled: true,
      role: 'admin',
    });

    expect(auth.updateUser).toHaveBeenCalledWith('u1', { disabled: true });
    expect(auth.revokeRefreshTokens).toHaveBeenCalledWith('u1');
    expect(auth.createCustomToken).toHaveBeenCalledWith('u1', {
      impersonatedBy: 'a1',
    });
  });
});

describe('profile and deletion', () => {
  it('updates only the given profile fields', async () => {
    const updateUser = vi.fn().mockResolvedValue({});
    await provider({ updateUser }).updateProfile('u1', { photoURL: null });
    expect(updateUser).toHaveBeenCalledWith('u1', { photoURL: null });
  });

  it('deletes the user, and treats an already deleted one as done', async () => {
    const deleteUser = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        Object.assign(new Error('gone'), { code: 'auth/user-not-found' }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('down'), { code: 'auth/internal-error' }),
      );
    const p = provider({ deleteUser });

    await p.deleteUser('u1');
    await p.deleteUser('u1');
    await expect(p.deleteUser('u1')).rejects.toThrow('down');
    expect(deleteUser).toHaveBeenCalledWith('u1');
  });
});
