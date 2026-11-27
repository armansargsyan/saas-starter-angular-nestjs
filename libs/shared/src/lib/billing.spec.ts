import { describe, expect, it } from 'vitest';
import { checkoutRequestSchema, portalRequestSchema } from './billing';

describe('checkoutRequestSchema', () => {
  it('accepts a paid plan for a workspace', () => {
    expect(
      checkoutRequestSchema.parse({ workspaceId: 'abc', plan: 'pro' }),
    ).toEqual({ workspaceId: 'abc', plan: 'pro' });
  });

  it.each([
    { workspaceId: 'abc', plan: 'free' },
    { workspaceId: 'abc', plan: 'enterprise' },
    { workspaceId: 'a/b', plan: 'pro' },
    { workspaceId: 'abc', plan: 'pro', priceId: 'price_x' },
    { plan: 'pro' },
  ])('rejects %j', (body) => {
    expect(checkoutRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('portalRequestSchema', () => {
  it('needs only a valid workspace id', () => {
    expect(portalRequestSchema.safeParse({ workspaceId: 'abc' }).success).toBe(
      true,
    );
    expect(
      portalRequestSchema.safeParse({ workspaceId: '__x__' }).success,
    ).toBe(false);
  });
});
