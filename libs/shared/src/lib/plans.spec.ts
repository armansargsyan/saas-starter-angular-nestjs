import { describe, expect, it } from 'vitest';
import { effectivePlanId, type WorkspacePlan } from './plans';

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
