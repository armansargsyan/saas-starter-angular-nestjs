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
        role: 'admin',
      });

      const token = await provider({ verifyIdToken }).verifyIdToken('tok');

      expect(verifyIdToken).toHaveBeenCalledWith('tok', true);
      expect(token).toEqual({
        uid: 'u1',
        email: 'a@example.com',
        emailVerified: true,
        issuedAt: new Date(1_780_000_000 * 1000),
        role: 'admin',
      });
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
