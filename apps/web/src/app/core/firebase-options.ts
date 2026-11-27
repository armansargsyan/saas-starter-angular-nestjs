import { InjectionToken, Provider } from '@angular/core';

/**
 * The Firebase web app config. It is public by design, but it is loaded at
 * runtime instead of being compiled in, so one build works for any project.
 */
export interface FirebaseOptions {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  storageBucket?: string;
  messagingSenderId?: string;
}

export const FIREBASE_OPTIONS = new InjectionToken<FirebaseOptions>(
  'FIREBASE_OPTIONS',
);

/**
 * Served by Firebase Hosting for the deployed app. In local dev it is a
 * gitignored file generated with `npm run firebase:web-config`.
 */
export const FIREBASE_CONFIG_URL = '/__/firebase/init.json';

const REQUIRED_KEYS = ['apiKey', 'authDomain', 'projectId', 'appId'] as const;

export function parseFirebaseOptions(value: unknown): FirebaseOptions {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Firebase config must be a JSON object');
  }
  const raw = value as Record<string, unknown>;
  const missing = REQUIRED_KEYS.filter(
    (key) => typeof raw[key] !== 'string' || raw[key] === '',
  );
  if (missing.length > 0) {
    throw new Error(`Firebase config is missing: ${missing.join(', ')}`);
  }
  const optional = (key: string) =>
    typeof raw[key] === 'string' ? raw[key] : undefined;

  return {
    apiKey: raw['apiKey'] as string,
    authDomain: raw['authDomain'] as string,
    projectId: raw['projectId'] as string,
    appId: raw['appId'] as string,
    storageBucket: optional('storageBucket'),
    messagingSenderId: optional('messagingSenderId'),
  };
}

/** Fetches the Firebase config before bootstrap; fails loudly if it's absent. */
export async function loadFirebaseOptions(
  fetchFn: typeof fetch = fetch,
): Promise<FirebaseOptions> {
  const fail = (reason: string) =>
    new Error(
      `Could not load Firebase config from ${FIREBASE_CONFIG_URL} (${reason}). ` +
        'It is served by Firebase Hosting; in local dev, run `npm run firebase:web-config`.',
    );

  const res = await fetchFn(FIREBASE_CONFIG_URL, { cache: 'no-cache' });
  if (!res.ok) {
    throw fail(`HTTP ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // e.g. an SPA fallback answering with index.html
    throw fail('response is not JSON');
  }
  return parseFirebaseOptions(body);
}

export function provideFirebaseOptions(options: FirebaseOptions): Provider {
  return { provide: FIREBASE_OPTIONS, useValue: options };
}
