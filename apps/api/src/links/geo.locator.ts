import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

/** IP → ISO country code, in memory. The IP itself is never stored. */
export abstract class GeoLocator {
  abstract country(ip: string | undefined): string | null;
}

type Lookup = (ip: string) => { country?: string } | null;

/**
 * Offline lookup with geoip-lite (bundled GeoLite data, ~100 MB in memory).
 * The data is loaded once at startup, so the first redirect isn't slow.
 */
@Injectable()
export class GeoipLiteLocator extends GeoLocator implements OnModuleInit {
  private readonly logger = new Logger(GeoipLiteLocator.name);
  private lookup: Lookup | null = null;

  async onModuleInit(): Promise<void> {
    try {
      const geoip = (await import('geoip-lite')).default;
      this.lookup = (ip) => geoip.lookup(ip);
    } catch (err) {
      // Clicks still count; they just have no country.
      this.logger.error(`geoip-lite failed to load: ${(err as Error).message}`);
    }
  }

  country(ip: string | undefined): string | null {
    if (!ip || !this.lookup) return null;
    // Express reports IPv4 clients as IPv4-mapped IPv6 (::ffff:1.2.3.4).
    const country = this.lookup(ip.replace(/^::ffff:/, ''))?.country;
    return country && /^[A-Z]{2}$/.test(country) ? country : null;
  }
}
