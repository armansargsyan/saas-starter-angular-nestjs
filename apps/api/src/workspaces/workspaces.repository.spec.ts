import { describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { toWorkspacePlan } from './workspaces.repository';

describe('toWorkspacePlan', () => {
  it('parses a stored plan with a Firestore timestamp', () => {
    const end = new Date('2027-01-01T00:00:00.000Z');
    expect(
      toWorkspacePlan({
        id: 'pro',
        status: 'active',
        currentPeriodEnd: Timestamp.fromDate(end),
        cancelAtPeriodEnd: true,
      }),
    ).toEqual({
      id: 'pro',
      status: 'active',
      currentPeriodEnd: '2027-01-01T00:00:00.000Z',
      cancelAtPeriodEnd: true,
    });
  });

  it('accepts an ISO string period end and defaults the rest', () => {
    expect(
      toWorkspacePlan({
        id: 'team',
        status: 'trialing',
        currentPeriodEnd: '2027-01-01T00:00:00.000Z',
      }),
    ).toMatchObject({
      currentPeriodEnd: '2027-01-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    });
  });

  it.each([
    undefined,
    null,
    'pro',
    { id: 'enterprise', status: 'active' },
    { id: 'pro', status: 'bogus' },
    { id: 'pro' },
  ])('treats %j as no plan', (raw) => {
    expect(toWorkspacePlan(raw)).toBeNull();
  });
});
