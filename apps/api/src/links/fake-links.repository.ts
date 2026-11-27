import {
  type Click,
  CodeTakenError,
  type DailyStats,
  LinksRepository,
  type NewLink,
  type StoredLink,
} from './links.repository';
import { utcDay } from './click-info';

/** In-memory LinksRepository for specs (no Firestore). */
export class FakeLinksRepository extends LinksRepository {
  readonly links = new Map<string, StoredLink>();
  readonly clicks: (Click & { code: string })[] = [];
  readonly daily = new Map<string, DailyStats>();
  /** Codes that `create` reports as taken, to simulate collisions. */
  readonly taken = new Set<string>();
  /** Codes of deleted links, never reissued (like `retiredCodes`). */
  readonly retired = new Set<string>();
  createdAt = new Date('2026-06-01T12:00:00Z');
  failClicks = false;

  async create(link: NewLink): Promise<StoredLink> {
    if (
      this.links.has(link.code) ||
      this.taken.has(link.code) ||
      this.retired.has(link.code)
    ) {
      throw new CodeTakenError(link.code);
    }
    const stored: StoredLink = {
      ...link,
      createdAt: this.createdAt,
      clickCount: 0,
      botClickCount: 0,
      lastClickedAt: null,
    };
    this.links.set(link.code, stored);
    return stored;
  }

  async get(code: string) {
    return this.links.get(code) ?? null;
  }

  async listByWorkspace(workspaceId: string, limit: number, cursor?: string) {
    const all = [...this.links.values()]
      .filter((link) => link.workspaceId === workspaceId)
      .reverse();
    const start = cursor ? all.findIndex((l) => l.code === cursor) + 1 : 0;
    const page = all.slice(start, start + limit);
    return {
      items: page,
      nextCursor:
        start + limit < all.length ? (page.at(-1)?.code ?? null) : null,
    };
  }

  async update(
    code: string,
    patch: { targetUrl?: string; title?: string | null },
  ) {
    const link = this.links.get(code);
    if (!link) return null;
    const updated = {
      ...link,
      ...(patch.targetUrl !== undefined && { targetUrl: patch.targetUrl }),
      ...(patch.title !== undefined && { title: patch.title }),
    };
    this.links.set(code, updated);
    return updated;
  }

  async delete(code: string) {
    if (!this.links.delete(code)) return false;
    this.retired.add(code);
    for (const key of [...this.daily.keys()]) {
      if (key.startsWith(`${code}/`)) this.daily.delete(key);
    }
    return true;
  }

  async recordClick(code: string, click: Click) {
    if (this.failClicks) throw new Error('firestore unavailable');
    this.clicks.push({ ...click, code });
    const key = `${code}/${utcDay(click.at)}`;
    const day = this.daily.get(key) ?? {
      date: utcDay(click.at),
      count: 0,
      bots: 0,
      referrers: {},
      countries: {},
      devices: {},
    };
    if (click.device === 'bot') day.bots++;
    else {
      day.count++;
      day.devices[click.device] = (day.devices[click.device] ?? 0) + 1;
      if (click.referrerHost) {
        day.referrers[click.referrerHost] =
          (day.referrers[click.referrerHost] ?? 0) + 1;
      }
      if (click.country) {
        day.countries[click.country] = (day.countries[click.country] ?? 0) + 1;
      }
    }
    this.daily.set(key, day);
  }

  async dailyStats(code: string, sinceDay: string) {
    return [...this.daily.entries()]
      .filter(
        ([key, day]) => key.startsWith(`${code}/`) && day.date >= sinceDay,
      )
      .map(([, day]) => day)
      .sort((a, b) => a.date.localeCompare(b.date));
  }
}
