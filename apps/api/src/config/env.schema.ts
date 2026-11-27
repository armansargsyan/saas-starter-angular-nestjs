import { z } from 'zod';

const nonEmpty = z
  .string({ error: 'is required' })
  .trim()
  .min(1, 'is required');

const prefixed = (prefix: string, what: string) =>
  nonEmpty.refine(
    (value) => value.startsWith(prefix) && value.length > prefix.length,
    {
      message: `must be a ${what} (${prefix}…)`,
    },
  );

/**
 * Every environment variable the api reads. Validated once at startup, so a
 * bad deploy fails immediately instead of on the first request that needs it.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Public origin of the app (web + short links), e.g. https://example.web.app.
  // Short URLs are built from it, and links pointing back to it are refused.
  APP_URL: nonEmpty
    .pipe(z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }))
    .transform((value) => new URL(value).origin),
  // Proxies in front of the api that append to X-Forwarded-For (Cloud Run: 1;
  // Firebase Hosting -> Cloud Run: 2). Used to find the real client IP.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),

  // Firebase Admin. Credentials come from Application Default Credentials
  // (Cloud Run's service account, or GOOGLE_APPLICATION_CREDENTIALS locally);
  // the SDK reads *_EMULATOR_HOST itself when the emulators are running.
  FIREBASE_PROJECT_ID: nonEmpty,

  // Stripe, test mode only: a live key is rejected outright.
  STRIPE_SECRET_KEY: prefixed('sk_test_', 'test-mode secret key'),
  STRIPE_WEBHOOK_SECRET: prefixed('whsec_', 'webhook signing secret'),
  STRIPE_PRICE_PRO: prefixed('price_', 'Stripe price id'),
  STRIPE_PRICE_TEAM: prefixed('price_', 'Stripe price id'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * `validate` hook for `ConfigModule.forRoot`. The error names the variables
 * and what is wrong with them, never their values.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  // Treat `KEY=` (empty, as in .env.example) the same as an unset variable.
  const input = Object.fromEntries(
    Object.entries(raw).filter(([, value]) => value !== ''),
  );
  const result = envSchema.safeParse(input);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}
