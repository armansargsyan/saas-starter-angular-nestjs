import { DecimalPipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  linkedSignal,
  signal,
} from '@angular/core';
import { type AdminStatsResponse, PLANS } from '@saas-starter/shared';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmSkeletonImports } from '@spartan-ng/helm/skeleton';
import { ClicksChart } from '../links/clicks-chart';
import { RankedList } from '../links/ranked-list';

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

/** The app sells in USD: with no billed subscription, MRR reads $0. */
const DEFAULT_CURRENCY = 'usd';

/**
 * Revenue and growth: KPI tiles (MRR, live subscriptions, signups), live
 * subscriptions by plan, and signups per day. All figures come from the api.
 */
@Component({
  selector: 'app-admin-stats',
  imports: [
    DecimalPipe,
    ClicksChart,
    RankedList,
    HlmButtonImports,
    HlmCardImports,
    HlmSkeletonImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      aria-labelledby="stats-title"
      class="grid gap-4"
      [attr.aria-busy]="stats.isLoading()"
    >
      <div class="flex flex-wrap items-center gap-3">
        <h2 id="stats-title" class="mr-auto text-lg font-semibold">
          Revenue and growth
        </h2>
        <div role="group" aria-label="Signups time range" class="flex gap-1">
          @for (range of ranges; track range) {
            <button
              hlmBtn
              size="sm"
              type="button"
              [variant]="days() === range ? 'secondary' : 'ghost'"
              [attr.aria-pressed]="days() === range"
              (click)="days.set(range)"
              [attr.data-testid]="'range-' + range"
            >
              {{ range }}d
            </button>
          }
        </div>
      </div>

      @if (stats.error()) {
        <div hlmCard role="alert" data-testid="stats-error">
          <p hlmCardContent class="text-sm">
            Couldn’t load the stats.
            <button
              hlmBtn
              variant="link"
              type="button"
              class="h-auto p-0"
              (click)="stats.reload()"
            >
              Try again
            </button>
          </p>
        </div>
      } @else if (value(); as s) {
        <dl class="grid gap-4 sm:grid-cols-3" data-testid="kpis">
          <div hlmCard size="sm" class="gap-1 px-4" data-testid="kpi-mrr">
            <dt class="text-muted-foreground text-sm">
              Monthly recurring revenue
            </dt>
            @for (m of mrr(); track m.currency; let first = $first) {
              <dd
                [class]="
                  first
                    ? 'text-2xl font-semibold tabular-nums'
                    : 'text-muted-foreground text-sm tabular-nums'
                "
              >
                {{ m.text }}
              </dd>
            }
            <dd class="text-muted-foreground text-xs">
              Active and past-due subscriptions; trials aren’t counted.
            </dd>
          </div>
          <div
            hlmCard
            size="sm"
            class="gap-1 px-4"
            data-testid="kpi-subscriptions"
          >
            <dt class="text-muted-foreground text-sm">Live subscriptions</dt>
            <dd class="text-2xl font-semibold tabular-nums">
              {{ liveTotal() | number }}
            </dd>
            <dd class="text-muted-foreground text-xs">
              Active, trialing and past due.
            </dd>
          </div>
          <div hlmCard size="sm" class="gap-1 px-4" data-testid="kpi-signups">
            <dt class="text-muted-foreground text-sm">
              Signups, last {{ s.signupsPerDay.length }} days
            </dt>
            <dd class="text-2xl font-semibold tabular-nums">
              {{ signupTotal() | number }}
            </dd>
            <dd class="text-muted-foreground text-xs">
              {{ signupsToday() | number }} today (UTC).
            </dd>
          </div>
        </dl>

        <div class="grid gap-4 md:grid-cols-3">
          <section
            hlmCard
            aria-labelledby="signups-title"
            class="md:col-span-2"
            data-testid="signups-card"
          >
            <div hlmCardHeader>
              <h3 hlmCardTitle id="signups-title">Signups per day</h3>
            </div>
            <div hlmCardContent>
              @if (signupTotal() === 0) {
                <p
                  class="text-muted-foreground text-sm"
                  data-testid="signups-empty"
                >
                  No signups in the last {{ s.signupsPerDay.length }} days.
                </p>
              } @else {
                <app-clicks-chart
                  [days]="s.signupsPerDay"
                  series="Signups"
                  unit="signup"
                />
              }
            </div>
          </section>
          <section
            hlmCard
            aria-labelledby="plans-title"
            data-testid="plans-card"
          >
            <div hlmCardHeader>
              <h3 hlmCardTitle id="plans-title">Subscriptions by plan</h3>
            </div>
            <div hlmCardContent>
              <app-ranked-list
                [items]="byPlan()"
                label="Live subscriptions by plan"
                empty="No live subscriptions yet."
              />
            </div>
          </section>
        </div>
      } @else {
        <div class="grid gap-4 sm:grid-cols-3" aria-hidden="true">
          @for (n of [1, 2, 3]; track n) {
            <hlm-skeleton class="h-28 w-full" data-testid="stats-loading" />
          }
        </div>
        <hlm-skeleton class="h-64 w-full" aria-hidden="true" />
      }
    </section>
  `,
})
export class AdminStats {
  protected readonly ranges = RANGES;
  protected readonly days = signal<Range>(30);

  protected readonly stats = httpResource<AdminStatsResponse>(
    () => `/api/admin/stats?days=${this.days()}`,
  );
  /**
   * The last stats loaded: kept while another range loads, so the tiles and
   * charts update in place instead of collapsing to skeletons. (`value()`
   * throws in an error state: read through hasValue.)
   */
  protected readonly value = linkedSignal<
    AdminStatsResponse | undefined,
    AdminStatsResponse | undefined
  >({
    source: () => (this.stats.hasValue() ? this.stats.value() : undefined),
    computation: (next, previous) => next ?? previous?.value,
  });

  /**
   * The default currency first (always shown, $0 without revenue), then any
   * others by code: amounts in different currencies don't compare.
   */
  protected readonly mrr = computed(() => {
    const mrr = this.value()?.mrr ?? [];
    const main = mrr.find((m) => m.currency === DEFAULT_CURRENCY) ?? {
      currency: DEFAULT_CURRENCY,
      amount: 0,
    };
    const others = mrr
      .filter((m) => m.currency !== DEFAULT_CURRENCY)
      .sort((a, b) => a.currency.localeCompare(b.currency));
    return [main, ...others].map((m) => ({
      currency: m.currency,
      text: formatMoney(m.amount, m.currency),
    }));
  });

  protected readonly liveTotal = computed(() => {
    const live = this.value()?.liveSubscriptions;
    return live ? live.pro + live.team : 0;
  });

  /** One hue, labelled rows (no legend needed); empty when nothing is live. */
  protected readonly byPlan = computed(() => {
    const live = this.value()?.liveSubscriptions;
    if (!live || live.pro + live.team === 0) return [];
    return [
      { label: PLANS.pro.name, count: live.pro },
      { label: PLANS.team.name, count: live.team },
    ];
  });

  protected readonly signupTotal = computed(() =>
    (this.value()?.signupsPerDay ?? []).reduce((sum, d) => sum + d.count, 0),
  );
  protected readonly signupsToday = computed(
    () => this.value()?.signupsPerDay.at(-1)?.count ?? 0,
  );
}

/** Minor units (as Stripe sends them) → a currency string; whole units from 10,000 up. */
export function formatMoney(minor: number, currency: string): string {
  const code = currency.toUpperCase();
  try {
    // Minor units per the currency (cents for USD, none for JPY), like Stripe.
    const digits =
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency: code,
      }).resolvedOptions().maximumFractionDigits ?? 2;
    const major = minor / 10 ** digits;
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      ...(Math.abs(major) >= 10_000 && { maximumFractionDigits: 0 }),
    }).format(major);
  } catch {
    // An unknown code: show it plainly rather than fail the tile.
    return `${(minor / 100).toFixed(2)} ${code}`;
  }
}
