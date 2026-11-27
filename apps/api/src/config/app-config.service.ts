import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

export interface FirebaseConfig {
  projectId: string;
}

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  prices: { pro: string; team: string };
}

/**
 * Typed access to the validated environment. Inject this instead of reading
 * `process.env`. Never log or return the Stripe values.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get nodeEnv(): Env['NODE_ENV'] {
    return this.get('NODE_ENV');
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  get port(): number {
    return this.get('PORT');
  }

  get firebase(): FirebaseConfig {
    return { projectId: this.get('FIREBASE_PROJECT_ID') };
  }

  get stripe(): StripeConfig {
    return {
      secretKey: this.get('STRIPE_SECRET_KEY'),
      webhookSecret: this.get('STRIPE_WEBHOOK_SECRET'),
      prices: {
        pro: this.get('STRIPE_PRICE_PRO'),
        team: this.get('STRIPE_PRICE_TEAM'),
      },
    };
  }

  private get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }
}
