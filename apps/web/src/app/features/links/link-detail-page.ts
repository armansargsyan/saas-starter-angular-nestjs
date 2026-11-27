import { DatePipe, DecimalPipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Link, LinkStatsResponse } from '@saas-starter/shared';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmSkeletonImports } from '@spartan-ng/helm/skeleton';
import { ClicksChart } from './clicks-chart';
import { RankedList } from './ranked-list';

export const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

/** Stats for one link: clicks per day, top referrers and countries, devices. */
@Component({
  selector: 'app-link-detail-page',
  imports: [
    DatePipe,
    DecimalPipe,
    RouterLink,
    HlmButtonImports,
    HlmCardImports,
    HlmSkeletonImports,
    ClicksChart,
    RankedList,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './link-detail-page.html',
})
export class LinkDetailPage {
  /** Route param `:code`. */
  readonly code = input.required<string>();

  protected readonly ranges = RANGES;
  protected readonly days = signal<Range>(30);

  protected readonly link = httpResource<Link>(
    () => `/api/links/${encodeURIComponent(this.code())}`,
  );
  protected readonly stats = httpResource<LinkStatsResponse>(
    () =>
      `/api/links/${encodeURIComponent(this.code())}/stats?days=${this.days()}`,
  );

  /**
   * Resource values, read safely: `value()` throws while a resource is in
   * an error state, so every read goes through `hasValue()`.
   */
  protected readonly linkValue = computed(() =>
    this.link.hasValue() ? this.link.value() : undefined,
  );
  protected readonly statsValue = computed(() =>
    this.stats.hasValue() ? this.stats.value() : undefined,
  );

  protected readonly referrers = computed(() =>
    (this.statsValue()?.topReferrers ?? []).map((r) => ({
      label: r.host,
      count: r.count,
    })),
  );
  protected readonly countries = computed(() =>
    (this.statsValue()?.topCountries ?? []).map((c) => ({
      label: countryName(c.country),
      count: c.count,
    })),
  );
  protected readonly devices = computed(() => {
    const d = this.statsValue()?.devices ?? { mobile: 0, desktop: 0 };
    const total = d.mobile + d.desktop;
    const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
    return [
      { label: 'Desktop', count: d.desktop, pct: pct(d.desktop) },
      { label: 'Mobile', count: d.mobile, pct: pct(d.mobile) },
    ];
  });
  protected readonly notFound = computed(() => {
    const err = this.link.error() as { status?: number } | undefined;
    return err?.status === 404;
  });
}

function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}
