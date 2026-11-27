import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema';

// Obviously fake values, built so they never look like real keys.
const valid = {
  FIREBASE_PROJECT_ID: 'demo-project',
  STRIPE_SECRET_KEY: 'sk_test_' + 'dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_' + 'dummy',
  STRIPE_PRICE_PRO: 'price_pro_dummy',
  STRIPE_PRICE_TEAM: 'price_team_dummy',
};

function errorOf(raw: Record<string, unknown>): string {
  try {
    validateEnv(raw);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected validateEnv to throw');
}

describe('validateEnv', () => {
  it('accepts a valid environment and applies defaults', () => {
    expect(validateEnv(valid)).toEqual({
      ...valid,
      NODE_ENV: 'development',
      PORT: 3000,
    });
  });

  it('coerces PORT from a string', () => {
    expect(validateEnv({ ...valid, PORT: '8080' }).PORT).toBe(8080);
  });

  it('treats empty values as missing', () => {
    expect(validateEnv({ ...valid, PORT: '' }).PORT).toBe(3000);
    expect(errorOf({ ...valid, FIREBASE_PROJECT_ID: '' })).toContain(
      'FIREBASE_PROJECT_ID',
    );
  });

  it('lists every missing variable', () => {
    const message = errorOf({});
    for (const key of Object.keys(valid)) {
      expect(message).toContain(`${key}: is required`);
    }
  });

  it('rejects a live-mode Stripe key without echoing it', () => {
    const liveKey = 'sk_' + 'live_dummy';
    const message = errorOf({ ...valid, STRIPE_SECRET_KEY: liveKey });

    expect(message).toContain('STRIPE_SECRET_KEY: must be a test-mode');
    expect(message).not.toContain(liveKey);
  });

  it('rejects a restricted key', () => {
    expect(
      errorOf({ ...valid, STRIPE_SECRET_KEY: 'rk_' + 'test_dummy' }),
    ).toContain('STRIPE_SECRET_KEY');
  });

  it('rejects a malformed webhook secret and price ids', () => {
    const message = errorOf({
      ...valid,
      STRIPE_WEBHOOK_SECRET: 'nope',
      STRIPE_PRICE_PRO: 'prod_123',
      STRIPE_PRICE_TEAM: 'prod_456',
    });
    expect(message).toContain('STRIPE_WEBHOOK_SECRET');
    expect(message).toContain('STRIPE_PRICE_PRO');
    expect(message).toContain('STRIPE_PRICE_TEAM');
  });

  it('rejects a value that is only the prefix', () => {
    const message = errorOf({
      ...valid,
      STRIPE_SECRET_KEY: 'sk_test_',
      STRIPE_PRICE_PRO: 'price_',
    });
    expect(message).toContain('STRIPE_SECRET_KEY');
    expect(message).toContain('STRIPE_PRICE_PRO');
  });

  it('rejects an invalid PORT and NODE_ENV', () => {
    const message = errorOf({ ...valid, PORT: '70000', NODE_ENV: 'staging' });
    expect(message).toContain('PORT');
    expect(message).toContain('NODE_ENV');
  });
});
