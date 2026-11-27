import { describe, expect, it } from 'vitest';
import {
  can,
  createInviteSchema,
  inviteTokenSchema,
  updateMemberSchema,
} from './teams';

describe('can', () => {
  it('gives billing and role changes to the owner only', () => {
    expect(can('owner', 'manageBilling')).toBe(true);
    expect(can('admin', 'manageBilling')).toBe(false);
    expect(can('admin', 'changeRoles')).toBe(false);
  });

  it('lets owners and admins manage members; members only use the team', () => {
    expect(can('admin', 'inviteMembers')).toBe(true);
    expect(can('admin', 'inviteAdmins')).toBe(false);
    expect(can('member', 'inviteMembers')).toBe(false);
    expect(can('member', 'removeMembers')).toBe(false);
    expect(can(null, 'renameTeam')).toBe(false);
  });
});

describe('createInviteSchema', () => {
  it('lowercases the email and defaults the role to member', () => {
    expect(createInviteSchema.parse({ email: ' Ada@Example.COM ' })).toEqual({
      email: 'ada@example.com',
      role: 'member',
    });
  });

  it.each([
    { email: 'nope' },
    { email: 'a@b.co', role: 'owner' },
    { email: 'a@b.co', uid: 'x' },
  ])('rejects %j', (body) => {
    expect(createInviteSchema.safeParse(body).success).toBe(false);
  });
});

describe('updateMemberSchema', () => {
  it('cannot make someone owner', () => {
    expect(updateMemberSchema.safeParse({ role: 'owner' }).success).toBe(false);
  });
});

describe('inviteTokenSchema', () => {
  it('accepts <team>.<invite>.<43-char secret> only', () => {
    const secret = 'a'.repeat(43);
    expect(
      inviteTokenSchema.safeParse({ token: `team1.inv1.${secret}` }).success,
    ).toBe(true);
    expect(
      inviteTokenSchema.safeParse({ token: `team1.inv1.${secret}x` }).success,
    ).toBe(false);
    expect(
      inviteTokenSchema.safeParse({ token: `a/b.inv1.${secret}` }).success,
    ).toBe(false);
    expect(inviteTokenSchema.safeParse({ token: 'garbage' }).success).toBe(
      false,
    );
  });
});
