import { describe, expect, it } from 'vitest';
import { inviteTokenSchema } from '@saas-starter/shared';
import {
  createInviteToken,
  hashSecret,
  parseInviteToken,
  sameHash,
} from './invite-token';

describe('invite tokens', () => {
  it('round-trips ids and stores only the secret hash', () => {
    const { token, secretHash } = createInviteToken('team1', 'inv1');
    const parsed = parseInviteToken(token);

    expect(parsed).toMatchObject({ teamId: 'team1', inviteId: 'inv1' });
    expect(hashSecret(parsed?.secret ?? '')).toBe(secretHash);
    expect(secretHash).not.toContain(parsed?.secret ?? '-');
    expect(inviteTokenSchema.safeParse({ token }).success).toBe(true);
  });

  it('makes a different secret every time', () => {
    const a = createInviteToken('t', 'i');
    const b = createInviteToken('t', 'i');
    expect(a.token).not.toBe(b.token);
  });

  it('rejects malformed tokens and compares hashes safely', () => {
    expect(parseInviteToken('a.b')).toBeNull();
    expect(parseInviteToken('a..c')).toBeNull();
    expect(parseInviteToken('__x__.inv.secret')).toBeNull();
    expect(parseInviteToken('team.__x__.secret')).toBeNull();
    expect(sameHash(hashSecret('x'), hashSecret('x'))).toBe(true);
    expect(sameHash(hashSecret('x'), hashSecret('y'))).toBe(false);
    expect(sameHash('', '')).toBe(false);
    expect(sameHash('abcd', hashSecret('x'))).toBe(false);
  });
});
