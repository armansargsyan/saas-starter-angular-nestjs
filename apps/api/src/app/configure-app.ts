import { type INestApplication, RequestMethod } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

export const GLOBAL_PREFIX = 'api';

export interface ConfigureAppOptions {
  /** Proxies in front of the api that append to X-Forwarded-For. */
  trustProxyHops: number;
}

/** App-wide HTTP setup, shared by `main.ts` and the e2e-style specs. */
export function configureApp(
  app: INestApplication,
  { trustProxyHops }: ConfigureAppOptions,
): void {
  // Public short links live at /r/:code, outside the /api prefix.
  app.setGlobalPrefix(GLOBAL_PREFIX, {
    exclude: [{ path: 'r/:code', method: RequestMethod.GET }],
  });
  // Trust exactly N hops so `req.ip` is the client, and a client-supplied
  // X-Forwarded-For can't spoof it.
  (app as NestExpressApplication).set('trust proxy', trustProxyHops);
}
