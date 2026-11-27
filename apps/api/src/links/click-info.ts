import type { DeviceType } from '@saas-starter/shared';
import { isbot } from 'isbot';

const MOBILE = /Mobi|Android|iPhone|iPad|iPod|Windows Phone|Opera Mini/i;

/** mobile, desktop or bot, from the user agent. A missing UA counts as a bot. */
export function deviceType(userAgent: string | undefined): DeviceType {
  if (!userAgent || isbot(userAgent)) return 'bot';
  return MOBILE.test(userAgent) ? 'mobile' : 'desktop';
}

/** The referrer's host only (no path or query), lowercased, without `www.`. */
export function referrerHost(referrer: string | undefined): string | null {
  if (!referrer) return null;
  try {
    const { protocol, hostname } = new URL(referrer);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    const host = hostname.toLowerCase().replace(/^www\./, '');
    // Hosts become Firestore map keys: `__x__` names are reserved there.
    if (!host || host.length > 253 || /^__.*__$/.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}

/** UTC calendar day, `yyyy-mm-dd`: the id of a `daily` aggregate doc. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
