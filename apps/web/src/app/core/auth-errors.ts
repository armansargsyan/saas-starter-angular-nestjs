/** Friendly messages for Firebase Auth error codes; null means "say nothing". */
export function authErrorMessage(err: unknown): string | null {
  const code = (err as { code?: string } | null)?.code ?? '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-login-credentials':
      return 'That email and password don’t match.';
    case 'auth/email-already-in-use':
      return 'An account with this email already exists. Sign in instead.';
    case 'auth/weak-password':
      return 'Choose a stronger password (at least 8 characters).';
    case 'auth/invalid-email':
      return 'Enter a valid email address.';
    case 'auth/user-disabled':
      return 'This account has been suspended.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a moment and try again.';
    case 'auth/network-request-failed':
      return 'Can’t reach the server. Check your connection.';
    case 'auth/account-exists-with-different-credential':
      return 'This email already signs in another way. Use that method.';
    case 'auth/popup-blocked':
      return 'The sign-in window was blocked. Allow pop-ups and try again.';
    case 'auth/unauthorized-domain':
      return 'Sign-in isn’t enabled for this site’s domain yet (Firebase Auth → authorized domains).';
    case 'auth/operation-not-allowed':
      return 'This sign-in method isn’t enabled yet (Firebase Auth → sign-in providers).';
    case 'app/impersonation-read-only':
      return 'Not available while viewing as another user (read-only).';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return null; // The user changed their mind.
    default:
      return 'Something went wrong. Please try again.';
  }
}
