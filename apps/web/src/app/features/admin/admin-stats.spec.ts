import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import type { AdminStatsResponse } from '@saas-starter/shared';
import { settle } from '../../../testing/settle';
import { AdminStats, formatMoney } from './admin-stats';

const days = (counts: number[]) =>
  counts.map((count, i) => ({
    date: `2026-11-${String(i + 1).padStart(2, '0')}`,
    count,
  }));

const STATS: AdminStatsResponse = {
  mrr: [
    { currency: 'usd', amount: 123_400 },
    { currency: 'eur', amount: 5_000 },
  ],
  liveSubscriptions: { pro: 7, team: 2 },
  signupsPerDay: days([1, 0, 4, 2]),
};

describe('AdminStats', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [AdminStats],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function render() {
    const fixture = TestBed.createComponent(AdminStats);
    TestBed.tick();
    const el = fixture.nativeElement as HTMLElement;
    const q = (s: string) => el.querySelector<HTMLElement>(s);
    return { fixture, el, q };
  }

  async function answer(
    fixture: Awaited<ReturnType<typeof render>>['fixture'],
    body: AdminStatsResponse,
    url = '/api/admin/stats?days=30',
  ) {
    http.expectOne(url).flush(body);
    await settle();
    await fixture.whenStable();
  }

  it('shows skeletons while loading', async () => {
    const { q } = await render();
    expect(q('[data-testid="stats-loading"]')).not.toBeNull();
    http.expectOne('/api/admin/stats?days=30');
  });

  it('shows the KPI tiles and both charts', async () => {
    const { fixture, q, el } = await render();
    await answer(fixture, STATS);

    const mrr = q('[data-testid="kpi-mrr"]')?.textContent ?? '';
    expect(mrr).toContain(formatMoney(123_400, 'usd'));
    expect(mrr).toContain(formatMoney(5_000, 'eur'));
    expect(q('[data-testid="kpi-subscriptions"]')?.textContent).toContain('9');
    const signups = q('[data-testid="kpi-signups"]')?.textContent ?? '';
    expect(signups).toContain('last 4 days');
    expect(signups).toContain('7');
    expect(signups).toContain('2 today');

    expect(
      q('[data-testid="signups-card"] svg')?.getAttribute('aria-label'),
    ).toBe('Signups per day, 4 days, 7 signups in total.');
    expect(el.querySelectorAll('[data-testid="bar"]')).toHaveLength(3);
    const plans = [...el.querySelectorAll('[data-testid="plans-card"] li')].map(
      (li) =>
        [...li.querySelectorAll('span')].map((s) => s.textContent?.trim()),
    );
    expect(plans).toEqual([
      ['Pro', '7'],
      ['Team', '2'],
    ]);
  });

  it('shows empty states (and $0 MRR) with no revenue or signups', async () => {
    const { fixture, q } = await render();
    await answer(fixture, {
      mrr: [],
      liveSubscriptions: { pro: 0, team: 0 },
      signupsPerDay: days([0, 0, 0]),
    });
    expect(q('[data-testid="kpi-mrr"]')?.textContent).toContain(
      formatMoney(0, 'usd'),
    );
    expect(q('[data-testid="signups-empty"]')?.textContent).toContain(
      'No signups in the last 3 days',
    );
    expect(q('[data-testid="signups-card"] svg')).toBeNull();
    expect(q('[data-testid="plans-card"]')?.textContent).toContain(
      'No live subscriptions yet.',
    );
  });

  it('shows an error with a retry', async () => {
    const { fixture, q } = await render();
    http
      .expectOne('/api/admin/stats?days=30')
      .flush(null, { status: 500, statusText: 'x' });
    await settle();
    await fixture.whenStable();
    expect(q('[data-testid="stats-error"]')?.textContent).toContain(
      'Couldn’t load the stats.',
    );
    q('[data-testid="stats-error"] button')?.click();
    TestBed.tick();
    await answer(fixture, STATS);
    expect(q('[data-testid="stats-error"]')).toBeNull();
    expect(q('[data-testid="kpis"]')).not.toBeNull();
  });

  it('changes the range, keeping the current figures while it loads', async () => {
    const { fixture, q } = await render();
    await answer(fixture, STATS);
    q('[data-testid="range-7"]')?.click();
    TestBed.tick();
    await settle();
    TestBed.tick();
    // Loading: no skeletons, the last figures stay, the section is busy.
    expect(q('[data-testid="stats-loading"]')).toBeNull();
    expect(q('[data-testid="kpi-signups"]')?.textContent).toContain(
      'last 4 days',
    );
    expect(q('section')?.getAttribute('aria-busy')).toBe('true');
    expect(q('[data-testid="range-7"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );

    await answer(
      fixture,
      { ...STATS, signupsPerDay: days([1, 1]) },
      '/api/admin/stats?days=7',
    );
    expect(q('[data-testid="kpi-signups"]')?.textContent).toContain(
      'last 2 days',
    );
    expect(q('section')?.getAttribute('aria-busy')).toBe('false');
  });

  it('lists MRR in the default currency first, then others by code', async () => {
    const { fixture, el } = await render();
    await answer(fixture, {
      ...STATS,
      // The api sorts by raw minor units, which don't compare across currencies.
      mrr: [
        { currency: 'jpy', amount: 900_000 },
        { currency: 'eur', amount: 5_000 },
        { currency: 'usd', amount: 1_200 },
      ],
    });
    const lines = [
      ...el.querySelectorAll('[data-testid="kpi-mrr"] dd.tabular-nums'),
    ].map((dd) => dd.textContent?.trim());
    expect(lines).toEqual([
      formatMoney(1_200, 'usd'),
      formatMoney(5_000, 'eur'),
      formatMoney(900_000, 'jpy'),
    ]);
  });

  it('formats minor units per currency', () => {
    expect(formatMoney(1999, 'usd')).toBe(
      new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'USD',
      }).format(19.99),
    );
    // JPY has no minor unit.
    expect(formatMoney(500, 'jpy')).toBe(
      new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'JPY',
      }).format(500),
    );
    expect(formatMoney(150, 'not-a-code')).toBe('1.50 NOT-A-CODE');
  });
});
