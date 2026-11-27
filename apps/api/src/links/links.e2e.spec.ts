import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type {
  Link,
  LinkListResponse,
  LinkStatsResponse,
} from '@saas-starter/shared';
import { configureApp } from '../app/configure-app';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Clock } from '../common/clock';
import { AppConfigService } from '../config/app-config.service';
import { IdentityProvider } from '../firebase/identity.provider';
import { WorkspacesRepository } from '../workspaces/workspaces.repository';
import { FakeLinksRepository } from './fake-links.repository';
import { GeoLocator } from './geo.locator';
import { CodeTakenError, LinksRepository } from './links.repository';
import { CREATE_LINK_LIMIT, LinksModule } from './links.module';

const NOW = new Date('2026-06-10T12:00:00Z');
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Bearer "<uid>" authenticates as that uid; "team-ws" has member "bob".
const identity = {
  verifyIdToken: vi.fn(async (token: string) => ({
    uid: token,
    emailVerified: true,
    issuedAt: NOW,
  })),
  getUser: vi.fn(),
};

@Global()
@Module({
  providers: [
    { provide: IdentityProvider, useValue: identity },
    {
      provide: AppConfigService,
      useValue: {
        appUrl: 'https://sho.rt',
        trustProxyHops: 1,
        firebase: { projectId: 'demo-proj' },
      },
    },
  ],
  exports: [IdentityProvider, AppConfigService],
})
class FakeGlobalsModule {}

describe('links api', () => {
  let app: INestApplication;
  let baseUrl: string;
  let repo: FakeLinksRepository;
  // A fresh throttler store per test, so earlier tests don't use up the
  // create quota (ThrottlerStorage is a one-method interface).
  let throttles = new ThrottlerStorageService();
  const throttleStore: ThrottlerStorage = {
    increment: (...args) => throttles.increment(...args),
  };
  const geo = {
    country: vi.fn((ip?: string) => (ip === '9.9.9.9' ? 'DE' : null)),
  };

  const call = (
    method: string,
    path: string,
    {
      as,
      body,
      headers = {},
    }: { as?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    fetch(`${baseUrl}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(as && { Authorization: `Bearer ${as}` }),
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const createLink = async (as: string, body: unknown, workspace = as) => {
    const res = await call('POST', `/api/workspaces/${workspace}/links`, {
      as,
      body,
    });
    return { res, link: (await res.json()) as Link };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeGlobalsModule, LinksModule],
      providers: [
        { provide: APP_GUARD, useClass: FirebaseAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(LinksRepository)
      .useFactory({ factory: () => new FakeLinksRepository() })
      .overrideProvider(WorkspacesRepository)
      .useValue({
        getPlan: vi.fn(),
        isMember: vi.fn(
          async (ws: string, uid: string) => ws === 'team-ws' && uid === 'bob',
        ),
      })
      .overrideProvider(GeoLocator)
      .useValue(geo)
      .overrideProvider(ThrottlerStorage)
      .useValue(throttleStore)
      .overrideProvider(Clock)
      .useValue({ now: () => NOW })
      .compile();

    repo = moduleRef.get(LinksRepository);
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app, { trustProxyHops: 1 });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    throttles.onApplicationShutdown();
    await app.close();
  });

  beforeEach(() => {
    repo.links.clear();
    repo.clicks.length = 0;
    repo.daily.clear();
    repo.taken.clear();
    repo.retired.clear();
    throttles.onApplicationShutdown();
    throttles = new ThrottlerStorageService();
    repo.failClicks = false;
  });

  describe('create', () => {
    it('creates a link with a random code in the personal workspace', async () => {
      const { res, link } = await createLink('alice', {
        targetUrl: 'https://example.com/page',
        title: 'Example',
      });

      expect(res.status).toBe(201);
      expect(link).toMatchObject({
        workspaceId: 'alice',
        targetUrl: 'https://example.com/page',
        title: 'Example',
        createdBy: 'alice',
        clickCount: 0,
      });
      expect(link.code).toMatch(/^[0-9A-Za-z]{7}$/);
      expect(link.shortUrl).toBe(`https://sho.rt/r/${link.code}`);
    });

    it('uses a custom slug and returns 409 when it is taken', async () => {
      const first = await createLink('alice', {
        targetUrl: 'https://a.com',
        slug: 'Promo',
      });
      expect(first.link.code).toBe('promo');

      const second = await createLink('bob', {
        targetUrl: 'https://b.com',
        slug: 'promo',
      });
      expect(second.res.status).toBe(409);
      expect(second.link).toMatchObject({ code: 'slug_taken' });
    });

    it('retries random codes on collision', async () => {
      const create = vi
        .spyOn(repo, 'create')
        .mockRejectedValueOnce(new CodeTakenError('taken1'));

      const { res } = await createLink('alice', { targetUrl: 'https://a.com' });

      expect(res.status).toBe(201);
      expect(create).toHaveBeenCalledTimes(2);
      create.mockRestore();
    });

    it('rejects invalid bodies with 400', async () => {
      for (const body of [
        { targetUrl: 'javascript:alert(1)' },
        { targetUrl: 'https://a.com', slug: 'admin' },
        { targetUrl: 'https://a.com', workspaceId: 'someone-else' },
        {},
      ]) {
        const { res } = await createLink('alice', body);
        expect(res.status).toBe(400);
      }
    });

    it('refuses links back to our own domain', async () => {
      for (const targetUrl of [
        'https://sho.rt/r/abc',
        'https://www.SHO.rt/x',
        'https://sho.rt./r/abc',
        'https://demo-proj.web.app/r/abc',
        'https://demo-proj.firebaseapp.com/r/abc',
        'https://api-xyz-ew.a.run.app/r/abc',
        'https://api-xyz-ew.a.run.app/R/abc',
      ]) {
        const { res, link } = await createLink('alice', { targetUrl });
        expect(res.status).toBe(400);
        expect(link).toMatchObject({ code: 'self_link' });
      }
    });

    it('allows other Cloud Run apps when the path is not a short link', async () => {
      const { res } = await createLink('alice', {
        targetUrl: 'https://someone-else.a.run.app/docs',
      });
      expect(res.status).toBe(201);
    });

    it('rejects malformed workspace ids and cursors with 400', async () => {
      for (const path of [
        '/api/workspaces/a%2Fb/links',
        '/api/workspaces/__x__/links',
        '/api/workspaces/alice/links?cursor=a%2Fb',
      ]) {
        expect((await call('GET', path, { as: 'alice' })).status).toBe(400);
      }
    });

    it("returns 404 for a workspace the caller isn't in", async () => {
      const { res } = await createLink(
        'alice',
        { targetUrl: 'https://a.com' },
        'bob',
      );
      expect(res.status).toBe(404);
      expect(repo.links.size).toBe(0);
    });

    it('lets a team member create in the team workspace', async () => {
      const { res, link } = await createLink(
        'bob',
        { targetUrl: 'https://a.com' },
        'team-ws',
      );
      expect(res.status).toBe(201);
      expect(link.workspaceId).toBe('team-ws');
    });

    it('requires authentication', async () => {
      const res = await call('POST', '/api/workspaces/alice/links', {
        body: { targetUrl: 'https://a.com' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('read, update, delete', () => {
    it('lists newest first with a cursor', async () => {
      for (const slug of ['one', 'two', 'three']) {
        await createLink('alice', { targetUrl: 'https://a.com', slug });
      }
      await createLink('bob', { targetUrl: 'https://b.com', slug: 'bobs' });

      const page1 = (await (
        await call('GET', '/api/workspaces/alice/links?limit=2', {
          as: 'alice',
        })
      ).json()) as LinkListResponse;
      expect(page1.items.map((l) => l.code)).toEqual(['three', 'two']);
      expect(page1.nextCursor).toBe('two');

      const page2 = (await (
        await call(
          'GET',
          `/api/workspaces/alice/links?limit=2&cursor=${page1.nextCursor}`,
          {
            as: 'alice',
          },
        )
      ).json()) as LinkListResponse;
      expect(page2.items.map((l) => l.code)).toEqual(['one']);
      expect(page2.nextCursor).toBeNull();
    });

    it("hides other users' links behind 404 for every operation", async () => {
      await createLink('bob', { targetUrl: 'https://b.com', slug: 'bobs' });

      expect(
        (await call('GET', '/api/links/bobs', { as: 'alice' })).status,
      ).toBe(404);
      expect(
        (
          await call('PATCH', '/api/links/bobs', {
            as: 'alice',
            body: { title: 'x' },
          })
        ).status,
      ).toBe(404);
      expect(
        (await call('DELETE', '/api/links/bobs', { as: 'alice' })).status,
      ).toBe(404);
      expect(
        (await call('GET', '/api/links/bobs/stats', { as: 'alice' })).status,
      ).toBe(404);
      expect(
        (await call('GET', '/api/workspaces/bob/links', { as: 'alice' }))
          .status,
      ).toBe(404);
      expect(repo.links.get('bobs')?.title).toBeNull();
    });

    it('updates the target and clears the title with an empty string', async () => {
      await createLink('alice', {
        targetUrl: 'https://a.com',
        slug: 'mine',
        title: 'Old',
      });

      const res = await call('PATCH', '/api/links/mine', {
        as: 'alice',
        body: { targetUrl: 'https://new.example.com', title: '' },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        targetUrl: 'https://new.example.com/', // stored normalized
        title: null,
      });
    });

    it('rejects changing the code or an empty patch', async () => {
      await createLink('alice', { targetUrl: 'https://a.com', slug: 'mine' });
      for (const body of [{ code: 'other' }, {}]) {
        expect(
          (await call('PATCH', '/api/links/mine', { as: 'alice', body }))
            .status,
        ).toBe(400);
      }
    });

    it('deletes with 204, after which the short link 404s', async () => {
      await createLink('alice', { targetUrl: 'https://a.com', slug: 'gone' });

      expect(
        (await call('DELETE', '/api/links/gone', { as: 'alice' })).status,
      ).toBe(204);
      expect((await call('GET', '/r/gone')).status).toBe(404);
    });

    it('never reissues a deleted code, so shared links cannot be hijacked', async () => {
      await createLink('alice', { targetUrl: 'https://a.com', slug: 'promo' });
      await call('DELETE', '/api/links/promo', { as: 'alice' });

      const again = await createLink('bob', {
        targetUrl: 'https://phish.example',
        slug: 'promo',
      });
      expect(again.res.status).toBe(409);
      expect((await call('GET', '/r/promo')).status).toBe(404);
    });
  });

  describe('GET /r/:code', () => {
    it('redirects with 302, no-store, without auth, and records the click', async () => {
      await createLink('alice', {
        targetUrl: 'https://example.com/landing',
        slug: 'golink',
      });

      const res = await call('GET', '/r/golink', {
        headers: {
          'User-Agent': MAC_CHROME,
          Referer: 'https://www.news.example.org/story?id=1',
          'X-Forwarded-For': '9.9.9.9',
        },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://example.com/landing');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(repo.clicks).toEqual([
        {
          code: 'golink',
          at: NOW,
          device: 'desktop',
          referrerHost: 'news.example.org',
          country: 'DE',
        },
      ]);
    });

    it('only trusts the configured number of proxy hops for the client IP', async () => {
      await createLink('alice', { targetUrl: 'https://a.com', slug: 'golink' });

      // A client-supplied XFF entry before the one our proxy appended is ignored.
      await call('GET', '/r/golink', {
        headers: {
          'User-Agent': MAC_CHROME,
          'X-Forwarded-For': '9.9.9.9, 1.2.3.4',
        },
      });

      expect(geo.country).toHaveBeenLastCalledWith('1.2.3.4');
    });

    it('returns a 404 page for unknown or malformed codes', async () => {
      for (const path of ['/r/nope123', '/r/a.b']) {
        const res = await call('GET', path);
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toContain('text/html');
      }
      expect(repo.clicks).toHaveLength(0);
    });

    it('still redirects when recording the click fails', async () => {
      await createLink('alice', { targetUrl: 'https://a.com', slug: 'golink' });
      repo.failClicks = true;

      const res = await call('GET', '/r/golink', {
        headers: { 'User-Agent': MAC_CHROME },
      });

      expect(res.status).toBe(302);
    });

    it('stops counting (but keeps redirecting) past the per-IP click limit', async () => {
      await createLink('alice', { targetUrl: 'https://a.com', slug: 'golink' });
      const headers = {
        'User-Agent': MAC_CHROME,
        'X-Forwarded-For': '5.5.5.5',
      };

      for (let i = 0; i < 12; i++) {
        expect((await call('GET', '/r/golink', { headers })).status).toBe(302);
      }
      expect(repo.clicks).toHaveLength(10);
    });

    it('redirects HEAD requests without counting them', async () => {
      await createLink('alice', { targetUrl: 'https://a.com', slug: 'golink' });

      const res = await call('HEAD', '/r/golink', {
        headers: { 'User-Agent': MAC_CHROME },
      });

      expect(res.status).toBe(302);
      expect(repo.clicks).toHaveLength(0);
    });

    it('routes /r case-sensitively, so /R/ is not a short link', async () => {
      await createLink('alice', { targetUrl: 'https://a.com', slug: 'golink' });
      expect((await call('GET', '/R/golink')).status).toBe(404);
    });

    it('sends no referrer to the target', async () => {
      await createLink('alice', { targetUrl: 'https://a.com', slug: 'golink' });
      const res = await call('GET', '/r/golink', {
        headers: { 'User-Agent': MAC_CHROME },
      });
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    });

    it('is not under /api', async () => {
      await createLink('alice', { targetUrl: 'https://a.com', slug: 'golink' });
      expect((await call('GET', '/api/r/golink')).status).toBe(404);
    });
  });

  describe('GET /api/links/:code/stats', () => {
    it('returns per-day clicks, top referrers and countries, excluding bots', async () => {
      await createLink('alice', { targetUrl: 'https://a.com', slug: 'golink' });
      const click = (ip: string, ua: string, referer?: string) =>
        call('GET', '/r/golink', {
          headers: {
            'User-Agent': ua,
            'X-Forwarded-For': ip,
            ...(referer && { Referer: referer }),
          },
        });
      await click('9.9.9.9', MAC_CHROME, 'https://twitter.com/x');
      await click('9.9.9.8', MAC_CHROME, 'https://twitter.com/y');
      await click(
        '9.9.9.9',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      );
      await click('7.7.7.7', 'Googlebot/2.1 (+http://www.google.com/bot.html)');

      const res = await call('GET', '/api/links/golink/stats?days=7', {
        as: 'alice',
      });
      const stats = (await res.json()) as LinkStatsResponse;

      expect(res.status).toBe(200);
      expect(stats.days).toHaveLength(7);
      expect(stats.days.at(-1)).toEqual({ date: '2026-06-10', count: 3 });
      expect(stats.days[0]).toEqual({ date: '2026-06-04', count: 0 });
      expect(stats).toMatchObject({
        totalClicks: 3,
        botClicks: 1,
        topReferrers: [{ host: 'twitter.com', count: 2 }],
        topCountries: [{ country: 'DE', count: 2 }],
        devices: { mobile: 1, desktop: 2 },
      });
    });

    it('validates the window', async () => {
      await createLink('alice', { targetUrl: 'https://a.com', slug: 'golink' });
      expect(
        (await call('GET', '/api/links/golink/stats?days=365', { as: 'alice' }))
          .status,
      ).toBe(400);
    });
  });

  describe('rate limit on create', () => {
    it(`allows ${CREATE_LINK_LIMIT.limit} creates per minute per user, then 429`, async () => {
      const statuses: number[] = [];
      for (let i = 0; i <= CREATE_LINK_LIMIT.limit; i++) {
        statuses.push(
          (await createLink('carol', { targetUrl: 'https://a.com' })).res
            .status,
        );
      }
      expect(statuses.slice(0, -1).every((s) => s === 201)).toBe(true);
      expect(statuses.at(-1)).toBe(429);

      // Another user is unaffected.
      expect(
        (await createLink('dave', { targetUrl: 'https://a.com' })).res.status,
      ).toBe(201);
    });
  });
});
