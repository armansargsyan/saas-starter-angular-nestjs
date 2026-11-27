import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PLANS } from '@saas-starter/shared';
import type {
  ApiErrorBody,
  Link,
  PlanLimitErrorBody,
  LinkListResponse,
  LinkStatsResponse,
  createLinkSchema,
  linkStatsQuerySchema,
  listLinksQuerySchema,
  updateLinkSchema,
} from '@saas-starter/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth-user';
import { Clock } from '../common/clock';
import { AppConfigService } from '../config/app-config.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { deviceType, referrerHost, utcDay } from './click-info';
import { ClickLimiter } from './click-limiter';
import { GeoLocator } from './geo.locator';
import {
  CodeTakenError,
  LinksRepository,
  type NewLink,
  PlanLimitError,
  type StoredLink,
  WorkspaceNotFoundError,
} from './links.repository';
import { ReferrerBudget } from './referrer-budget';
import { generateShortCode, isPlausibleCode } from './short-code';

const RANDOM_CODE_ATTEMPTS = 5;
const TOP_N = 10;
const DAY_MS = 86_400_000;

export interface RedirectRequest {
  code: string;
  ip: string | undefined;
  userAgent: string | undefined;
  referrer: string | undefined;
  /** False for HEAD requests (link checkers): redirect, but don't count. */
  countClick: boolean;
}

@Injectable()
export class LinksService {
  private readonly logger = new Logger(LinksService.name);

  constructor(
    private readonly links: LinksRepository,
    private readonly access: WorkspaceAccessService,
    private readonly config: AppConfigService,
    private readonly geo: GeoLocator,
    private readonly clickLimiter: ClickLimiter,
    private readonly referrers: ReferrerBudget,
    private readonly clock: Clock,
  ) {}

  async create(
    user: AuthUser,
    workspaceId: string,
    body: z.output<typeof createLinkSchema>,
  ): Promise<Link> {
    await this.access.assertAccess(user, workspaceId);
    this.assertNotSelfLink(body.targetUrl);

    const newLink = {
      workspaceId,
      targetUrl: body.targetUrl,
      title: body.title || null,
      createdBy: user.uid,
    };
    const personalOwner = workspaceId === user.uid ? user.uid : null;

    if (body.slug) {
      const link = await this.tryCreate(
        { ...newLink, code: body.slug },
        personalOwner,
      );
      if (!link) {
        const body: ApiErrorBody<'slug_taken'> = {
          statusCode: 409,
          code: 'slug_taken',
          message: 'That short code is already taken',
        };
        throw new ConflictException(body);
      }
      return this.toLink(link);
    }

    for (let attempt = 0; attempt < RANDOM_CODE_ATTEMPTS; attempt++) {
      const link = await this.tryCreate(
        { ...newLink, code: generateShortCode() },
        personalOwner,
      );
      if (link) return this.toLink(link);
    }
    // 5 collisions in a 3.5e12 space: something is wrong, not just unlucky.
    throw new ServiceUnavailableException('Could not allocate a short code');
  }

  /** The created link, or null when the code is taken (or retired). */
  private async tryCreate(
    link: NewLink,
    personalOwner: string | null,
  ): Promise<StoredLink | null> {
    try {
      return await this.links.create(link, personalOwner);
    } catch (err) {
      if (err instanceof CodeTakenError) return null;
      if (err instanceof PlanLimitError) {
        const body: PlanLimitErrorBody = {
          statusCode: 403,
          code: 'plan_limit_reached',
          message: `Your ${PLANS[err.plan].name} plan allows ${err.limit} links. Upgrade or delete some to add more.`,
          resource: 'links',
          limit: err.limit,
          plan: err.plan,
        };
        throw new ForbiddenException(body);
      }
      // A team the caller belongs to, whose workspace doc is gone.
      if (err instanceof WorkspaceNotFoundError) {
        throw new NotFoundException('Workspace not found');
      }
      throw err;
    }
  }

  async list(
    user: AuthUser,
    workspaceId: string,
    query: z.output<typeof listLinksQuerySchema>,
  ): Promise<LinkListResponse> {
    await this.access.assertAccess(user, workspaceId);
    const page = await this.links.listByWorkspace(
      workspaceId,
      query.limit,
      query.cursor,
    );
    return {
      items: page.items.map((link) => this.toLink(link)),
      nextCursor: page.nextCursor,
    };
  }

  async get(user: AuthUser, code: string): Promise<Link> {
    return this.toLink(await this.getAccessible(user, code));
  }

  async update(
    user: AuthUser,
    code: string,
    body: z.output<typeof updateLinkSchema>,
  ): Promise<Link> {
    await this.getAccessible(user, code);
    if (body.targetUrl) this.assertNotSelfLink(body.targetUrl);

    const updated = await this.links.update(code, {
      targetUrl: body.targetUrl,
      // An empty title clears it.
      title: body.title === undefined ? undefined : body.title || null,
    });
    if (!updated) throw linkNotFound();
    return this.toLink(updated);
  }

  async delete(user: AuthUser, code: string): Promise<void> {
    await this.getAccessible(user, code);
    await this.links.delete(code);
  }

  async stats(
    user: AuthUser,
    code: string,
    query: z.output<typeof linkStatsQuerySchema>,
  ): Promise<LinkStatsResponse> {
    await this.getAccessible(user, code);

    const today = this.clock.now();
    const dates = Array.from({ length: query.days }, (_, i) =>
      utcDay(new Date(today.getTime() - (query.days - 1 - i) * DAY_MS)),
    );
    const daily = await this.links.dailyStats(code, dates[0]);
    const byDate = new Map(daily.map((day) => [day.date, day]));

    const referrers: Record<string, number> = {};
    const countries: Record<string, number> = {};
    const devices = { mobile: 0, desktop: 0 };
    let botClicks = 0;
    for (const day of daily) {
      addAll(referrers, day.referrers);
      addAll(countries, day.countries);
      devices.mobile += day.devices.mobile ?? 0;
      devices.desktop += day.devices.desktop ?? 0;
      botClicks += day.bots;
    }

    const days = dates.map((date) => ({
      date,
      count: byDate.get(date)?.count ?? 0,
    }));
    return {
      code,
      days,
      totalClicks: days.reduce((sum, day) => sum + day.count, 0),
      botClicks,
      topReferrers: top(referrers).map(([host, count]) => ({ host, count })),
      topCountries: top(countries).map(([country, count]) => ({
        country,
        count,
      })),
      devices,
    };
  }

  /**
   * Resolves a public short link and records the click. The write is awaited
   * (one small batch) because Cloud Run throttles CPU once the response is
   * sent, so fire-and-forget writes can be lost; a failed write is logged and
   * never blocks the redirect.
   */
  async resolveRedirect(req: RedirectRequest): Promise<string | null> {
    if (!isPlausibleCode(req.code)) return null;
    const link = await this.links.get(req.code);
    if (!link) return null;

    if (req.countClick && this.clickLimiter.allow(req.ip, req.code)) {
      const at = this.clock.now();
      const host = referrerHost(req.referrer);
      try {
        await this.links.recordClick(req.code, {
          at,
          device: deviceType(req.userAgent),
          referrerHost:
            host && this.referrers.admit(req.code, utcDay(at), host),
          country: this.geo.country(req.ip),
        });
      } catch (err) {
        this.logger.warn(
          `Click on ${req.code} not recorded: ${(err as Error).message}`,
        );
      }
    }
    return link.targetUrl;
  }

  /** 404 for both "doesn't exist" and "not yours", so codes can't be probed. */
  private async getAccessible(
    user: AuthUser,
    code: string,
  ): Promise<StoredLink> {
    const link = isPlausibleCode(code) ? await this.links.get(code) : null;
    if (!link || !(await this.access.canAccess(user, link.workspaceId))) {
      throw linkNotFound();
    }
    return link;
  }

  /**
   * Links back to our own short links would loop or launder redirects. Our
   * hosts: APP_URL plus the project's default Firebase Hosting domains; and
   * any `/r/` path on Cloud Run (`*.run.app`), which serves the same route.
   */
  private assertNotSelfLink(targetUrl: string): void {
    const url = new URL(targetUrl);
    const target = normalizeHost(url.hostname);
    const projectId = this.config.firebase.projectId;
    const own = [
      normalizeHost(new URL(this.config.appUrl).hostname),
      `${projectId}.web.app`,
      `${projectId}.firebaseapp.com`,
    ];
    const isOwnHost = own.some(
      (host) => target === host || target.endsWith(`.${host}`),
    );
    const isCloudRunShortLink =
      (target === 'run.app' || target.endsWith('.run.app')) &&
      url.pathname.toLowerCase().startsWith('/r/');
    if (isOwnHost || isCloudRunShortLink) {
      const body: ApiErrorBody<'self_link'> = {
        statusCode: 400,
        code: 'self_link',
        message: 'Links to this site are not allowed',
      };
      throw new BadRequestException(body);
    }
  }

  private toLink(link: StoredLink): Link {
    return {
      code: link.code,
      shortUrl: `${this.config.appUrl}/r/${link.code}`,
      workspaceId: link.workspaceId,
      targetUrl: link.targetUrl,
      title: link.title,
      createdBy: link.createdBy,
      createdAt: link.createdAt.toISOString(),
      clickCount: link.clickCount,
      lastClickedAt: link.lastClickedAt?.toISOString() ?? null,
    };
  }
}

/** Lowercase, without the trailing dot of a fully qualified name. */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, '');
}

function linkNotFound() {
  return new NotFoundException('Link not found');
}

function addAll(into: Record<string, number>, from: Record<string, number>) {
  for (const [key, count] of Object.entries(from)) {
    into[key] = (into[key] ?? 0) + count;
  }
}

function top(counts: Record<string, number>): [string, number][] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_N);
}
