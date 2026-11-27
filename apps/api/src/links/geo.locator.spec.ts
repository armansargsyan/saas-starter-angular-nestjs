import { describe, expect, it, vi } from 'vitest';

vi.mock('geoip-lite', () => ({
  default: {
    lookup: vi.fn(
      (ip: string) =>
        ({ '1.2.3.4': { country: 'DE' }, '5.6.7.8': { country: 'XXL' } })[ip] ??
        null,
    ),
  },
}));

const { GeoipLiteLocator } = await import('./geo.locator');

describe('GeoipLiteLocator', () => {
  it('returns null until loaded, then looks up countries', async () => {
    const geo = new GeoipLiteLocator();
    expect(geo.country('1.2.3.4')).toBeNull();

    await geo.onModuleInit();

    expect(geo.country('1.2.3.4')).toBe('DE');
    expect(geo.country('::ffff:1.2.3.4')).toBe('DE');
    expect(geo.country('9.9.9.9')).toBeNull();
    expect(geo.country(undefined)).toBeNull();
  });

  it('drops anything that is not a 2-letter code', async () => {
    const geo = new GeoipLiteLocator();
    await geo.onModuleInit();
    expect(geo.country('5.6.7.8')).toBeNull();
  });
});
