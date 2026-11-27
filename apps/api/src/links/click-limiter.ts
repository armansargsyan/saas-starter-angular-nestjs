import { Injectable } from '@nestjs/common';
import { Clock } from '../common/clock';

/** Counted clicks per (IP, link) per window; extra clicks still redirect. */
export const CLICKS_PER_WINDOW = 10;
export const CLICK_WINDOW_MS = 60_000;
const MAX_KEYS = 50_000;

/**
 * Stops click inflation: one IP can add at most N clicks to a link per
 * minute. Over the limit the visitor is still redirected, the click just
 * isn't recorded. In memory, so per instance; good enough for abuse basics.
 */
@Injectable()
export class ClickLimiter {
  private readonly windows = new Map<
    string,
    { start: number; count: number }
  >();

  constructor(private readonly clock: Clock) {}

  /** True if this click should be recorded. */
  allow(ip: string | undefined, code: string): boolean {
    if (!ip) return true;
    const key = `${clientKey(ip)}|${code}`;
    const now = this.clock.now().getTime();
    const window = this.windows.get(key);

    if (!window || now - window.start >= CLICK_WINDOW_MS) {
      if (this.windows.size >= MAX_KEYS) this.evictExpired(now);
      // Still full: a flood of distinct clients. Don't count new ones, and
      // don't reset everyone else's windows either.
      if (this.windows.size >= MAX_KEYS) return false;
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    window.count++;
    return window.count <= CLICKS_PER_WINDOW;
  }

  private evictExpired(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= CLICK_WINDOW_MS) this.windows.delete(key);
    }
  }
}

/**
 * IPv4 as is; IPv6 by its /64 prefix, since one client usually controls a
 * whole /64 and could otherwise rotate addresses for fresh limits.
 */
export function clientKey(ip: string): string {
  const v4 = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (!v4.includes(':')) return v4;

  const [head, tail = ''] = v4.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = Math.max(0, 8 - left.length - right.length);
  const groups = v4.includes('::')
    ? [...left, ...Array(missing).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}
