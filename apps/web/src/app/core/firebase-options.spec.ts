import {
  FIREBASE_CONFIG_URL,
  loadFirebaseOptions,
  parseFirebaseOptions,
} from './firebase-options';

const valid = {
  apiKey: 'test-api-key',
  authDomain: 'demo.firebaseapp.com',
  projectId: 'demo',
  appId: '1:123:web:abc',
  storageBucket: 'demo.firebasestorage.app',
  messagingSenderId: '123',
  version: '2',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('parseFirebaseOptions', () => {
  it('keeps only the known keys', () => {
    expect(parseFirebaseOptions(valid)).toEqual({
      apiKey: 'test-api-key',
      authDomain: 'demo.firebaseapp.com',
      projectId: 'demo',
      appId: '1:123:web:abc',
      storageBucket: 'demo.firebasestorage.app',
      messagingSenderId: '123',
    });
  });

  it('rejects a config with missing required keys', () => {
    expect(() =>
      parseFirebaseOptions({ projectId: 'demo', apiKey: '' }),
    ).toThrow('Firebase config is missing: apiKey, authDomain, appId');
  });

  it('rejects a non-object', () => {
    expect(() => parseFirebaseOptions(null)).toThrow('must be a JSON object');
  });
});

describe('loadFirebaseOptions', () => {
  it('fetches and parses the hosting init.json', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(valid));

    const options = await loadFirebaseOptions(fetchFn);

    expect(fetchFn).toHaveBeenCalledWith(FIREBASE_CONFIG_URL, {
      cache: 'no-cache',
    });
    expect(options.projectId).toBe('demo');
  });

  it('fails with a hint when the config is not served', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, 404));

    await expect(loadFirebaseOptions(fetchFn)).rejects.toThrow(
      /HTTP 404.*firebase:web-config/,
    );
  });

  it('fails with a hint when an SPA fallback returns HTML', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response('<!doctype html>', { status: 200 }));

    await expect(loadFirebaseOptions(fetchFn)).rejects.toThrow(
      /not JSON.*firebase:web-config/,
    );
  });
});
