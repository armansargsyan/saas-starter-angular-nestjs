import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { OVERLAY_DEFAULT_CONFIG } from '@angular/cdk/overlay';
import { provideRouter } from '@angular/router';
import type {
  Link,
  LinkListResponse,
  UsageResponse,
} from '@saas-starter/shared';
import { FakeAuth } from '../../../testing/fake-auth';
import { settle } from '../../../testing/settle';
import { AuthService } from '../../core/auth.service';
import { BillingService } from '../../core/billing.service';
import { DashboardPage } from './dashboard-page';

const link = (code: string, overrides: Partial<Link> = {}): Link => ({
  code,
  shortUrl: `https://sho.rt/r/${code}`,
  workspaceId: 'u1',
  targetUrl: `https://example.com/${code}`,
  title: null,
  createdBy: 'u1',
  createdAt: '2026-06-01T12:00:00.000Z',
  clickCount: 3,
  lastClickedAt: null,
  ...overrides,
});

const usage = (used: number, limit: number | null = 10): UsageResponse => ({
  workspaceId: 'u1',
  plan: limit === null ? 'pro' : 'free',
  links: { used, limit },
  members: { used: 1, limit: 1 },
});

describe('DashboardPage', () => {
  let auth: FakeAuth;
  let http: HttpTestingController;
  let billing: { startCheckout: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    auth = new FakeAuth();
    auth.signIn('u1');
    billing = { startCheckout: vi.fn().mockResolvedValue({ ok: true }) };
    TestBed.configureTestingModule({
      imports: [DashboardPage],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: auth },
        { provide: BillingService, useValue: billing },
        { provide: OVERLAY_DEFAULT_CONFIG, useValue: { usePopover: false } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    document.body
      .querySelectorAll('.cdk-overlay-container')
      .forEach((n) => n.remove());
  });

  const LIST = '/api/workspaces/u1/links?limit=50';
  const USAGE = '/api/usage?workspaceId=u1';

  async function render(
    items: Link[] = [link('alpha'), link('beta', { title: 'Beta launch' })],
    u: UsageResponse = usage(2),
    nextCursor: string | null = null,
  ) {
    const fixture = TestBed.createComponent(DashboardPage);
    TestBed.tick();
    http
      .expectOne(LIST)
      .flush({ items, nextCursor } satisfies LinkListResponse);
    http.expectOne(USAGE).flush(u);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const q = (sel: string) => el.querySelector<HTMLElement>(sel);
    const doc = (sel: string) => document.body.querySelector<HTMLElement>(sel);
    return { fixture, el, q, doc };
  }

  /** After a mutation the list and usage are fetched again. */
  async function expectReload(
    fixture: { whenStable(): Promise<unknown> },
    items: Link[],
    u = usage(items.length),
  ) {
    await settle();
    TestBed.tick(); // reload() sends on the next change detection
    http.expectOne(LIST).flush({ items, nextCursor: null });
    http.expectOne(USAGE).flush(u);
    await fixture.whenStable();
  }

  it('lists links with their short URL, target, title and clicks', async () => {
    const { el } = await render();
    const rows = el.querySelectorAll('[data-testid="link-list"] li');
    expect(rows).toHaveLength(2);
    expect(
      rows[0].querySelector('[data-testid="short-url"]')?.textContent,
    ).toContain('sho.rt/r/alpha');
    expect(rows[1].textContent).toContain('Beta launch');
    expect(
      rows[0].querySelector('[data-testid="clicks"]')?.textContent,
    ).toContain('3 clicks');
  });

  it('filters by code, URL or title', async () => {
    const { fixture, el, q } = await render();
    const search = q('[data-testid="search"]') as HTMLInputElement;
    search.value = 'launch';
    search.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(el.querySelectorAll('[data-testid="link-list"] li')).toHaveLength(1);

    search.value = 'nothing-matches';
    search.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(q('[data-testid="no-matches"]')?.textContent).toContain(
      'nothing-matches',
    );
  });

  it('shows an empty state with a create button', async () => {
    const { q } = await render([], usage(0));
    expect(q('[data-testid="empty"]')?.textContent).toContain('No links yet');
  });

  it('copies the short URL and announces it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const { fixture, q } = await render();

    q('[data-testid="copy"]')?.click();
    await settle();
    await fixture.whenStable();

    expect(writeText).toHaveBeenCalledWith('https://sho.rt/r/alpha');
    expect(q('[data-testid="announcement"]')?.textContent).toContain(
      'Copied https://sho.rt/r/alpha',
    );
  });

  it('deletes after confirmation, then reloads', async () => {
    const { fixture, q, doc } = await render();
    q('[data-testid="delete"]')?.click();
    await fixture.whenStable();
    expect(doc('h2[hlmAlertDialogTitle]')?.textContent).toContain(
      'Delete alpha?',
    );

    doc('[data-testid="confirm-delete"]')?.click();
    await settle();
    const req = http.expectOne('/api/links/alpha');
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
    await expectReload(fixture, [link('beta')]);

    expect(q('[data-testid="announcement"]')?.textContent).toContain(
      'Deleted alpha',
    );
  });

  describe('usage', () => {
    it('shows used of limit', async () => {
      const { q } = await render(undefined, usage(4));
      expect(q('[data-testid="usage-text"]')?.textContent).toContain(
        '4 of 10 used',
      );
      expect(q('[data-testid="upgrade-prompt"]')).toBeNull();
      // 4 of 10 → 40% (the indicator ignores max, so the value is a percentage).
      expect(
        q('hlm-progress')?.getAttribute('aria-valuenow') ??
          q('[role="progressbar"]')?.getAttribute('aria-valuenow'),
      ).toBe('40');
    });

    it('shows unlimited on Pro', async () => {
      const { q } = await render(undefined, usage(42, null));
      expect(q('[data-testid="usage-text"]')?.textContent).toContain(
        '42 used · unlimited',
      );
    });

    it('prompts to upgrade at the limit and starts Checkout', async () => {
      const { q } = await render(undefined, usage(10));
      expect(q('[data-testid="upgrade-prompt"]')?.textContent).toContain(
        'limit of 10 links',
      );
      q('[data-testid="upgrade"]')?.click();
      await settle();
      expect(billing.startCheckout).toHaveBeenCalledWith({
        workspaceId: 'u1',
        plan: 'pro',
      });
    });
  });

  describe('create dialog', () => {
    async function openDialog() {
      const view = await render();
      view.q('[data-testid="new-link"]')?.click();
      await view.fixture.whenStable();
      return view;
    }
    const type = (id: string, value: string) => {
      const input = document.getElementById(id) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    const save = async (fixture: { whenStable(): Promise<unknown> }) => {
      (document.querySelector('[data-testid="save"]') as HTMLElement).click();
      await settle();
      await fixture.whenStable();
    };

    it('validates with the shared schema before calling the api', async () => {
      const { fixture } = await openDialog();
      type('link-target', 'javascript:alert(1)');
      type('link-slug', 'ab');
      await save(fixture);

      expect(
        document.getElementById('link-target-error')?.textContent,
      ).toContain('The URL must be an http(s) URL.');
      expect(document.getElementById('link-slug-error')?.textContent).toContain(
        '3–32 characters',
      );
      http.expectNone('/api/workspaces/u1/links');
    });

    it('creates the link, closes and reloads', async () => {
      const { fixture, q } = await openDialog();
      type('link-target', 'https://example.com/new');
      type('link-slug', 'My-Promo');
      await save(fixture);

      const req = http.expectOne('/api/workspaces/u1/links');
      expect(req.request.body).toEqual({
        targetUrl: 'https://example.com/new',
        slug: 'my-promo', // the shared schema lowercases slugs
      });
      req.flush(link('my-promo'));
      await expectReload(fixture, [
        link('my-promo'),
        link('alpha'),
        link('beta'),
      ]);

      expect(q('[data-testid="announcement"]')?.textContent).toContain(
        'Created https://sho.rt/r/my-promo',
      );
    });

    it('puts a taken slug on the slug field', async () => {
      const { fixture } = await openDialog();
      type('link-target', 'https://example.com/new');
      type('link-slug', 'taken');
      await save(fixture);

      http
        .expectOne('/api/workspaces/u1/links')
        .flush({ code: 'slug_taken' }, { status: 409, statusText: 'Conflict' });
      await settle();
      await fixture.whenStable();
      expect(document.getElementById('link-slug-error')?.textContent).toContain(
        'taken',
      );
    });

    it('explains the plan limit inside the dialog', async () => {
      const { fixture } = await openDialog();
      type('link-target', 'https://example.com/new');
      await save(fixture);

      http.expectOne('/api/workspaces/u1/links').flush(
        {
          statusCode: 403,
          code: 'plan_limit_reached',
          message: 'Your Free plan allows 10 links.',
          resource: 'links',
          limit: 10,
          plan: 'free',
        },
        { status: 403, statusText: 'Forbidden' },
      );
      await settle();
      // The meter's count was stale: it is fetched again.
      TestBed.tick();
      http.expectOne(USAGE).flush(usage(10));
      await fixture.whenStable();
      expect(
        document.querySelector('[data-testid="limit-in-dialog"]')?.textContent,
      ).toContain('Your Free plan allows 10 links.');
      expect(document.activeElement?.id).not.toBe('link-target'); // no field to fix
    });

    it('edits target and title, not the code', async () => {
      const { fixture, q } = await render();
      q('[data-testid="edit"]')?.click();
      await fixture.whenStable();
      expect(document.getElementById('link-slug')).toBeNull();
      expect(
        (document.getElementById('link-target') as HTMLInputElement).value,
      ).toBe('https://example.com/alpha');

      type('link-title', 'Renamed');
      await save(fixture);
      const req = http.expectOne('/api/links/alpha');
      expect(req.request.method).toBe('PATCH');
      expect(req.request.body).toEqual({
        targetUrl: 'https://example.com/alpha',
        title: 'Renamed',
      });
      req.flush(link('alpha', { title: 'Renamed' }));
      // An edit can't change usage: only the list is fetched again.
      await settle();
      TestBed.tick();
      http.expectOne(LIST).flush({
        items: [link('alpha', { title: 'Renamed' }), link('beta')],
        nextCursor: null,
      });
      http.expectNone(USAGE);
      await fixture.whenStable();
      expect(fixture.nativeElement.textContent).toContain('Renamed');
    });
  });

  it('loads more pages with the cursor', async () => {
    const { fixture, el, q } = await render([link('a1')], usage(2), 'a1');
    q('[data-testid="load-more"]')?.click();
    await settle();
    http
      .expectOne(
        (r) =>
          r.url === '/api/workspaces/u1/links' &&
          r.params.get('cursor') === 'a1',
      )
      .flush({ items: [link('a2')], nextCursor: null });
    await settle();
    await fixture.whenStable();
    expect(el.querySelectorAll('[data-testid="link-list"] li')).toHaveLength(2);
    expect(q('[data-testid="load-more"]')).toBeNull();
  });

  describe('errors and read-only', () => {
    const fail = { status: 500, statusText: 'Server Error' };

    it('shows retries when both the list and usage fail', async () => {
      const fixture = TestBed.createComponent(DashboardPage);
      TestBed.tick();
      http.expectOne(LIST).flush('boom', fail);
      http.expectOne(USAGE).flush('boom', fail);
      await fixture.whenStable();
      const el = fixture.nativeElement as HTMLElement;

      expect(
        el.querySelector('[data-testid="load-error"]')?.textContent,
      ).toContain('Couldn’t load your links');
      expect(el.querySelector('[data-testid="usage-error"]')).not.toBeNull();
    });

    it('still shows the list when only usage fails, and retries usage', async () => {
      const fixture = TestBed.createComponent(DashboardPage);
      TestBed.tick();
      http.expectOne(LIST).flush({ items: [link('alpha')], nextCursor: null });
      http.expectOne(USAGE).flush('boom', fail);
      await fixture.whenStable();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelectorAll('[data-testid="link-list"] li')).toHaveLength(
        1,
      );

      el.querySelector<HTMLElement>(
        '[data-testid="usage-error"] button',
      )?.click();
      TestBed.tick();
      http.expectOne(USAGE).flush(usage(1));
      await fixture.whenStable();
      expect(
        el.querySelector('[data-testid="usage-text"]')?.textContent,
      ).toContain('1 of 10');
    });

    it('treats deleting an already-deleted link as done', async () => {
      const { fixture, q, doc } = await render();
      q('[data-testid="delete"]')?.click();
      await fixture.whenStable();
      doc('[data-testid="confirm-delete"]')?.click();
      await settle();
      http
        .expectOne('/api/links/alpha')
        .flush({}, { status: 404, statusText: 'Not Found' });
      await expectReload(fixture, [link('beta')]);
      expect(q('[data-testid="notice"]')).toBeNull();
      expect(q('[data-testid="announcement"]')?.textContent).toContain(
        'Deleted alpha',
      );
    });

    it('starts over when the workspace changes (no pages from the old one)', async () => {
      const { fixture, el, q } = await render([link('a1')], usage(2), 'a1');
      q('[data-testid="load-more"]')?.click();
      await settle();
      http
        .expectOne((r) => r.params.get('cursor') === 'a1')
        .flush({ items: [link('a2')], nextCursor: null });
      await settle();
      await fixture.whenStable();
      expect(el.querySelectorAll('[data-testid="link-list"] li')).toHaveLength(
        2,
      );

      auth.signIn('u2'); // the workspace is now u2's
      TestBed.tick();
      http.expectOne('/api/workspaces/u2/links?limit=50').flush({
        items: [link('b1', { workspaceId: 'u2' })],
        nextCursor: null,
      });
      http.expectOne('/api/usage?workspaceId=u2').flush(usage(1));
      await fixture.whenStable();
      const codes = [
        ...el.querySelectorAll('[data-testid="link-list"] li'),
      ].map((li) => li.getAttribute('data-code'));
      expect(codes).toEqual(['b1']);
    });

    it('shows a failed delete visibly (not only to screen readers)', async () => {
      const { fixture, q, doc } = await render();
      q('[data-testid="delete"]')?.click();
      await fixture.whenStable();
      doc('[data-testid="confirm-delete"]')?.click();
      await settle();
      http.expectOne('/api/links/alpha').flush({}, fail);
      await expectReload(fixture, [link('alpha'), link('beta')]);

      expect(q('[data-testid="notice"]')?.textContent).toContain(
        'Couldn’t delete alpha',
      );
      expect(document.activeElement?.id).toBe('link-search');
    });

    it('shows a failed copy visibly', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
        configurable: true,
      });
      const { fixture, q } = await render();
      q('[data-testid="copy"]')?.click();
      await settle();
      await fixture.whenStable();
      expect(q('[data-testid="notice"]')?.textContent).toContain(
        'copy it manually',
      );
    });

    it('drops a "Load more" page that arrives after a refresh (no duplicates)', async () => {
      const { fixture, el, q } = await render([link('a1')], usage(2), 'a1');
      q('[data-testid="load-more"]')?.click();
      await settle();
      const stale = http.expectOne(
        (r) =>
          r.url === '/api/workspaces/u1/links' &&
          r.params.get('cursor') === 'a1',
      );

      // A create refreshes the list while that page is in flight.
      q('[data-testid="new-link"]')?.click();
      await fixture.whenStable();
      const input = document.getElementById('link-target') as HTMLInputElement;
      input.value = 'https://example.com/n';
      input.dispatchEvent(new Event('input'));
      (document.querySelector('[data-testid="save"]') as HTMLElement).click();
      await settle();
      http.expectOne('/api/workspaces/u1/links').flush(link('n1'));
      await expectReload(fixture, [link('n1'), link('a1')]);

      stale.flush({ items: [link('a2')], nextCursor: null });
      await settle();
      await fixture.whenStable();
      const codes = [
        ...el.querySelectorAll('[data-testid="link-list"] li'),
      ].map((li) => li.getAttribute('data-code'));
      expect(codes).toEqual(['n1', 'a1']);
    });

    it('hides create, edit and delete in an impersonated (read-only) session', async () => {
      auth.impersonatedBy.set('admin-1');
      const { q } = await render();
      expect(q('[data-testid="new-link"]')).toBeNull();
      expect(q('[data-testid="edit"]')).toBeNull();
      expect(q('[data-testid="delete"]')).toBeNull();
      expect(q('[data-testid="copy"]')).not.toBeNull();
    });

    it('focuses the first invalid field when the dialog form is invalid', async () => {
      const { fixture, q } = await render();
      q('[data-testid="new-link"]')?.click();
      await fixture.whenStable();
      (document.querySelector('[data-testid="save"]') as HTMLElement).click();
      await settle();
      await fixture.whenStable();
      expect(document.activeElement?.id).toBe('link-target');
    });
  });
});
