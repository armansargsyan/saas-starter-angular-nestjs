import { describe, expect, it } from 'vitest';
import {
  effectivePlanId,
  hasRoomFor,
  PLAN_IDS,
  PLANS,
  type WorkspacePlan,
} from './plans';

const plan = (overrides: Partial<WorkspacePlan>): WorkspacePlan => ({
  id: 'pro',
  status: 'active',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  ...overrides,
});

describe('effectivePlanId', () => {
  it('is free without a plan', () => {
    expect(effectivePlanId(null)).toBe('free');
    expect(effectivePlanId(undefined)).toBe('free');
  });

  it.each(['active', 'trialing', 'past_due'] as const)(
    'keeps the paid plan while %s',
    (status) => {
      expect(effectivePlanId(plan({ status }))).toBe('pro');
    },
  );

  it.each(['canceled', 'unpaid', 'incomplete', 'paused'] as const)(
    'falls back to free when %s',
    (status) => {
      expect(effectivePlanId(plan({ id: 'team', status }))).toBe('free');
    },
  );
});

describe('PLANS', () => {
  it('defines every plan id with matching ids', () => {
    for (const id of PLAN_IDS) expect(PLANS[id].id).toBe(id);
  });

  it('matches the advertised limits', () => {
    expect(PLANS.free.limits).toEqual({ links: 10, members: 1 });
    expect(PLANS.pro.limits).toEqual({ links: null, members: 1 });
    expect(PLANS.team.limits).toEqual({ links: null, members: 10 });
  });
});

describe('hasRoomFor', () => {
  it('allows up to the limit, not past it', () => {
    expect(hasRoomFor(9, 10)).toBe(true);
    expect(hasRoomFor(10, 10)).toBe(false);
    expect(hasRoomFor(15, 10)).toBe(false); // after a downgrade
  });

  it('treats null as unlimited', () => {
    expect(hasRoomFor(1_000_000, null)).toBe(true);
  });
});
