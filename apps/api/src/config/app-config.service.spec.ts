import { afterEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';

const env = {
  NODE_ENV: 'production',
  PORT: '8080',
  APP_URL: 'https://app.example.com',
  FIREBASE_PROJECT_ID: 'demo-project',
  STRIPE_SECRET_KEY: 'sk_test_' + 'dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_' + 'dummy',
  STRIPE_PRICE_PRO: 'price_pro_dummy',
  STRIPE_PRICE_TEAM: 'price_team_dummy',
};

// `ConfigModule.forRoot()` validates when its module file is evaluated, so
// stub the env first and import a fresh copy per test.
async function compile() {
  vi.resetModules();
  const { AppConfigModule } = await import('./app-config.module');
  const { AppConfigService } = await import('./app-config.service');
  const moduleRef = await Test.createTestingModule({
    imports: [AppConfigModule],
  }).compile();
  return moduleRef.get(AppConfigService);
}

describe('AppConfigService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exposes typed, validated values', async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

    const config = await compile();

    expect(config.port).toBe(8080);
    expect(config.appUrl).toBe('https://app.example.com');
    expect(config.trustProxyHops).toBe(1);
    expect(config.isProduction).toBe(true);
    expect(config.firebase).toEqual({ projectId: 'demo-project' });
    expect(config.stripe).toEqual({
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      prices: { pro: 'price_pro_dummy', team: 'price_team_dummy' },
    });
  });

  it('rejects invalid config when the module loads', async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_' + 'live_dummy');

    await expect(compile()).rejects.toThrow(/STRIPE_SECRET_KEY/);
  });
});
