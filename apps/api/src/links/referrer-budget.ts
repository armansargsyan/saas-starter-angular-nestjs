import { Injectable } from '@nestjs/common';

/** Distinct referrer hosts kept per link per day; the rest count as "other". */
export const MAX_REFERRERS_PER_DAY = 100;
export const OTHER_REFERRER = 'other';
const MAX_TRACKED = 10_000;

/**
 * Bounds the referrer map in each `daily` doc. Referrer hosts are chosen by
 * whoever sends the request, so without a cap a flood of fake hosts could push
 * the doc past Firestore's size and index limits and break click counting.
 * In memory and per instance: the bound is MAX_REFERRERS_PER_DAY × instances,
 * with no extra read on the redirect path.
 */
@Injectable()
export class ReferrerBudget {
  private readonly seen = new Map<string, Set<string>>();

  /** The key to record for this referrer: the host itself, or "other". */
  admit(code: string, day: string, host: string): string {
    const key = `${code}|${day}`;
    let hosts = this.seen.get(key);
    if (!hosts) {
      // Evict the oldest (link, day) entries, never everyone's budget at once:
      // a global reset would let a flood re-open the cap for a target link.
      while (this.seen.size >= MAX_TRACKED) {
        const oldest = this.seen.keys().next().value;
        if (oldest === undefined) break;
        this.seen.delete(oldest);
      }
      hosts = new Set();
      this.seen.set(key, hosts);
    }
    if (hosts.has(host)) return host;
    if (hosts.size >= MAX_REFERRERS_PER_DAY) return OTHER_REFERRER;
    hosts.add(host);
    return host;
  }
}
