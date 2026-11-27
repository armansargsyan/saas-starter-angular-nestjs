import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import type { Link, LinkStatsResponse } from '@saas-starter/shared';
import { LinkDetailPage } from './link-detail-page';

const LINK: Link = {
  code: 'promo',
  shortUrl: 'https://sho.rt/r/promo',
  workspaceId: 'u1',
  targetUrl: 'https://example.com/landing',
  title: 'Spring promo',
  createdBy: 'u1',
  createdAt: '2026-06-01T12:00:00.000Z',
  clickCount: 9,
  lastClickedAt: null,
};

const stats = (days: number): LinkStatsResponse => ({
  code: 'promo',
  days: Array.from({ length: days }, (_, i) => ({
    date: new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10),
    count: i === days - 1 ? 6 : 0,
  })),
  totalClicks: 6,
  botClicks: 2,
  topReferrers: [
    { host: 'news.example.org', count: 4 },
    { host: 'x.com', count: 2 },
  ],
  topCountries: [
    { country: 'DE', count: 5 },
    { country: 'US', count: 1 },
  ],
  devices: { mobile: 2, desktop: 4 },
});

describe('LinkDetailPage', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [LinkDetailPage],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function render() {
    const fixture = TestBed.createComponent(LinkDetailPage);
    fixture.componentRef.setInput('code', 'promo');
    TestBed.tick();
    http.expectOne('/api/links/promo').flush(LINK);
    http.expectOne('/api/links/promo/stats?days=30').flush(stats(30));
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el, q: (s: string) => el.querySelector<HTMLElement>(s) };
  }

  it('shows the link, totals, the chart and the breakdowns', async () => {
    const { el, q } = await render();
    expect(q('[data-testid="link-title"]')?.textContent).toContain(
      'Spring promo',
    );
    expect(q('[data-testid="totals"]')?.textContent).toContain(
      '6 clicks in the last 30 days',
    );
    expect(q('[data-testid="totals"]')?.textContent).toContain('2 from bots');
    expect(
      el.querySelectorAll('[data-testid="chart-table"] tbody tr'),
    ).toHaveLength(30);
    expect(el.textContent).toContain('news.example.org');
    expect(el.textContent).toContain('Germany'); // country names, not codes
    expect(q('[data-testid="devices"]')?.textContent).toContain('67%');
  });

  it('switches the range and fetches again', async () => {
    const { fixture, q } = await render();
    q('[data-testid="range-7"]')?.click();
    TestBed.tick();
    http.expectOne('/api/links/promo/stats?days=7').flush(stats(7));
    await fixture.whenStable();

    expect(q('[data-testid="range-7"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(q('[data-testid="totals"]')?.textContent).toContain('last 7 days');
  });

  it('says when the link does not exist (or is not yours)', async () => {
    const fixture = TestBed.createComponent(LinkDetailPage);
    fixture.componentRef.setInput('code', 'gone');
    TestBed.tick();
    http
      .expectOne('/api/links/gone')
      .flush({}, { status: 404, statusText: 'Not Found' });
    http
      .expectOne('/api/links/gone/stats?days=30')
      .flush({}, { status: 404, statusText: 'Not Found' });
    await fixture.whenStable();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="not-found"]',
      ),
    ).not.toBeNull();
  });

  it('survives server errors on the link and on the stats, with a retry', async () => {
    const fixture = TestBed.createComponent(LinkDetailPage);
    fixture.componentRef.setInput('code', 'promo');
    TestBed.tick();
    const fail = { status: 500, statusText: 'Server Error' };
    http.expectOne('/api/links/promo').flush('boom', fail);
    http.expectOne('/api/links/promo/stats?days=30').flush('boom', fail);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.textContent).toContain('Couldn’t load this link.');
    expect(el.textContent).toContain('Couldn’t load the stats.');
    expect(el.textContent).toContain('No clicks yet.'); // breakdowns fall back, no crash

    el.querySelector<HTMLElement>('[data-testid="retry-link"]')?.click();
    TestBed.tick();
    http.expectOne('/api/links/promo').flush(LINK);
    await fixture.whenStable();
    [...el.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Try again'))
      ?.click();
    TestBed.tick();
    http.expectOne('/api/links/promo/stats?days=30').flush(stats(30));
    await fixture.whenStable();
    expect(el.querySelector('[data-testid="totals"]')).not.toBeNull();
    expect(
      el.querySelector('[data-testid="link-title"]')?.textContent,
    ).toContain('Spring promo');
  });
});
