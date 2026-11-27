import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Invite tokens are `<teamId>.<inviteId>.<secret>`: the ids locate the invite
 * doc directly, the 256-bit random secret proves possession. Only the
 * secret's SHA-256 is stored, so a database leak doesn't leak usable invites.
 */
export function createInviteToken(teamId: string, inviteId: string) {
  const secret = randomBytes(32).toString('base64url');
  return {
    token: `${teamId}.${inviteId}.${secret}`,
    secretHash: hashSecret(secret),
  };
}

export function parseInviteToken(
  token: string,
): { teamId: string; inviteId: string; secret: string } | null {
  const parts = token.split('.');
  // Empty parts, or ids Firestore reserves (`__x__`), are never valid.
  if (
    parts.length !== 3 ||
    parts.some((part) => !part || /^__.*__$/.test(part))
  ) {
    return null;
  }
  const [teamId, inviteId, secret] = parts;
  return { teamId, inviteId, secret };
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Constant-time comparison of two hex hashes. */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return (
    left.length === right.length &&
    left.length > 0 &&
    timingSafeEqual(left, right)
  );
}
