import { authErrorMessage } from './auth-errors';

describe('authErrorMessage', () => {
  it.each([
    ['auth/invalid-credential', 'don’t match'],
    ['auth/email-already-in-use', 'already exists'],
    ['auth/weak-password', 'stronger password'],
    ['auth/user-disabled', 'suspended'],
    ['auth/too-many-requests', 'Too many attempts'],
    ['auth/network-request-failed', 'connection'],
    ['auth/user-mismatch', 'different account'],
    ['auth/something-new', 'Something went wrong'],
  ])('%s', (code, text) => {
    expect(authErrorMessage({ code })).toContain(text);
  });

  it('stays quiet when the user closes the Google popup', () => {
    expect(authErrorMessage({ code: 'auth/popup-closed-by-user' })).toBeNull();
    expect(
      authErrorMessage({ code: 'auth/cancelled-popup-request' }),
    ).toBeNull();
  });

  it('handles non-Firebase errors', () => {
    expect(authErrorMessage(new Error('boom'))).toContain(
      'Something went wrong',
    );
    expect(authErrorMessage(null)).toContain('Something went wrong');
  });
});
