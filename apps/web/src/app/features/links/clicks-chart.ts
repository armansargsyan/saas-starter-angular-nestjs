import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  signal,
} from '@angular/core';

export interface DayCount {
  date: string; // yyyy-mm-dd (UTC)
  count: number;
}

const HEIGHT = 180;
const PAD = { top: 12, right: 8, bottom: 24, left: 36 };
const MAX_BAR = 24;
const GAP = 2;
const RADIUS = 4;

/**
 * A count per day (clicks by default; signups in the admin panel) as a
 * single-series column chart (dataviz spec): one hue, 2px gaps, bars capped
 * at 24px with 4px rounded tops anchored to the baseline, a recessive grid,
 * a hover/focus tooltip per bar, arrow-key navigation, and a table view. No
 * legend: the title names the series.
 */
@Component({
  selector: 'app-clicks-chart',
  // Block-level so the ResizeObserver measures the available width.
  host: { class: 'block w-full' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="relative" data-testid="chart">
      <svg
        role="group"
        tabindex="0"
        [attr.aria-label]="label()"
        [attr.aria-describedby]="'chart-focus-' + uid"
        [attr.width]="width()"
        [attr.height]="height"
        class="focus-visible:ring-ring/50 block w-full rounded-md outline-none focus-visible:ring-3"
        (keydown)="onKey($event)"
        (pointerleave)="active.set(null)"
        (blur)="active.set(null)"
      >
        <!-- Grid and y labels: recessive. -->
        @for (tick of ticks(); track tick.value) {
          <line
            [attr.x1]="pad.left"
            [attr.x2]="width() - pad.right"
            [attr.y1]="tick.y"
            [attr.y2]="tick.y"
            class="stroke-border"
            stroke-width="1"
          />
          <text
            [attr.x]="pad.left - 6"
            [attr.y]="tick.y"
            text-anchor="end"
            dominant-baseline="middle"
            class="fill-muted-foreground text-[11px] tabular-nums"
          >
            {{ tick.value }}
          </text>
        }
        @for (bar of bars(); track bar.date; let i = $index) {
          <!-- Hit target: the whole band, taller than the bar. -->
          <rect
            [attr.x]="bar.bandX"
            [attr.y]="pad.top"
            [attr.width]="bar.bandW"
            [attr.height]="plotH()"
            fill="transparent"
            (pointerenter)="active.set(i)"
            data-testid="bar-hit"
          />
          @if (bar.h > 0) {
            <path
              [attr.d]="bar.path"
              class="pointer-events-none fill-(--chart-series)"
              [class.opacity-60]="active() !== null && active() !== i"
              data-testid="bar"
            />
          }
        }
        @for (label of xLabels(); track label.x) {
          <text
            [attr.x]="label.x"
            [attr.y]="height - 6"
            [attr.text-anchor]="label.anchor"
            class="fill-muted-foreground text-[11px]"
          >
            {{ label.text }}
          </text>
        }
      </svg>

      @if (tooltip(); as tip) {
        <div
          class="bg-popover text-popover-foreground pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border px-2.5 py-1.5 text-xs shadow-md"
          [style.left.px]="tip.x"
          [style.top.px]="tip.y - 6"
          data-testid="tooltip"
        >
          <span class="text-muted-foreground">{{ tip.date }}</span>{{ ' '
          }}<span class="ml-1 font-medium tabular-nums">{{
            amount(tip.count)
          }}</span>
        </div>
      }
      <p [id]="'chart-focus-' + uid" class="sr-only" aria-live="polite">
        {{ liveText() }}
      </p>
    </div>

    <details class="mt-3 text-sm">
      <summary
        class="text-muted-foreground hover:text-foreground cursor-pointer"
      >
        Show as table
      </summary>
      <table class="mt-2 w-full text-left text-sm" data-testid="chart-table">
        <caption class="sr-only">
          {{
            caption()
          }}
        </caption>
        <thead>
          <tr class="border-b">
            <th scope="col" class="py-1.5 font-medium">Day</th>
            <th scope="col" class="py-1.5 text-right font-medium">
              {{ series() }}
            </th>
          </tr>
        </thead>
        <tbody>
          @for (day of days(); track day.date) {
            <tr class="border-b last:border-0">
              <td class="py-1.5">{{ format(day.date) }}</td>
              <td class="py-1.5 text-right tabular-nums">{{ day.count }}</td>
            </tr>
          }
        </tbody>
      </table>
    </details>
  `,
})
export class ClicksChart {
  readonly days = input.required<DayCount[]>();
  /** What is counted, as a title ("Clicks") and a unit ("click"; +s for many). */
  readonly series = input('Clicks');
  readonly unit = input('click');

  protected readonly caption = computed(() => `${this.series()} per day`);
  protected readonly pad = PAD;
  protected readonly height = HEIGHT;
  protected readonly uid = Math.random().toString(36).slice(2, 8);
  protected readonly width = signal(640);
  protected readonly active = signal<number | null>(null);

  protected readonly plotH = computed(() => HEIGHT - PAD.top - PAD.bottom);
  private readonly max = computed(() =>
    niceMax(Math.max(0, ...this.days().map((d) => d.count))),
  );

  protected readonly ticks = computed(() => {
    const max = this.max();
    return [0, max / 2, max].map((value) => ({
      value,
      y: PAD.top + this.plotH() - (value / max) * this.plotH(),
    }));
  });

  protected readonly bars = computed(() => {
    const days = this.days();
    const plotW = Math.max(1, this.width() - PAD.left - PAD.right);
    const band = plotW / Math.max(1, days.length);
    const barW = Math.max(1, Math.min(MAX_BAR, band - GAP));
    const baseline = PAD.top + this.plotH();
    return days.map((day, i) => {
      const h = (day.count / this.max()) * this.plotH();
      const x = PAD.left + i * band + (band - barW) / 2;
      return {
        ...day,
        h,
        bandX: PAD.left + i * band,
        bandW: band,
        centerX: x + barW / 2,
        path: roundedTop(x, baseline, barW, h),
      };
    });
  });

  /** First, middle and last day: enough to read the range without crowding. */
  protected readonly xLabels = computed(() => {
    const bars = this.bars();
    if (bars.length === 0) return [];
    const pick =
      bars.length > 2
        ? [0, Math.floor((bars.length - 1) / 2), bars.length - 1]
        : bars.map((_, i) => i);
    return pick.map((i, n) => ({
      x: bars[i].centerX,
      text: this.format(bars[i].date),
      anchor:
        n === 0 && pick.length > 1
          ? 'start'
          : n === pick.length - 1 && pick.length > 1
            ? 'end'
            : 'middle',
    }));
  });

  protected readonly tooltip = computed(() => {
    const i = this.active();
    const bar = i === null ? undefined : this.bars()[i];
    if (!bar) return null;
    const baseline = PAD.top + this.plotH();
    // Keep the (centred) tooltip inside the card near the first/last bars.
    const half = 64;
    return {
      // Never past the middle on very narrow charts.
      x: Math.max(
        Math.min(half, this.width() / 2),
        Math.min(bar.centerX, this.width() - Math.min(half, this.width() / 2)),
      ),
      y: baseline - bar.h,
      date: this.format(bar.date),
      count: bar.count,
    };
  });

  /** Announced while moving through the days (the instruction otherwise). */
  protected readonly liveText = computed(() => {
    const tip = this.tooltip();
    return tip
      ? `${tip.date}: ${this.amount(tip.count)}`
      : 'Use the arrow keys to read each day.';
  });

  protected readonly label = computed(() => {
    const days = this.days();
    const total = days.reduce((sum, d) => sum + d.count, 0);
    return `${this.caption()}, ${days.length} days, ${this.amount(total)} in total.`;
  });

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      // Older browsers and jsdom: keep the default width.
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(([entry]) => {
        if (entry.contentRect.width > 0)
          this.width.set(Math.floor(entry.contentRect.width));
      });
      observer.observe(host);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  protected onKey(event: KeyboardEvent): void {
    const last = this.days().length - 1;
    if (last < 0) return;
    const current = this.active();
    const next =
      event.key === 'ArrowRight'
        ? Math.min(last, (current ?? -1) + 1)
        : event.key === 'ArrowLeft'
          ? Math.max(0, (current ?? last + 1) - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : event.key === 'Escape'
                ? null
                : undefined;
    if (next === undefined) return;
    event.preventDefault();
    this.active.set(next);
  }

  protected amount(count: number): string {
    return `${count} ${this.unit()}${count === 1 ? '' : 's'}`;
  }

  protected format(date: string): string {
    return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  }
}

/** A bar growing up from the baseline, with 4px rounded top corners. */
export function roundedTop(
  x: number,
  baseline: number,
  w: number,
  h: number,
): string {
  const r = Math.min(RADIUS, h, w / 2);
  const top = baseline - h;
  return [
    `M${x},${baseline}`,
    `V${top + r}`,
    `Q${x},${top} ${x + r},${top}`,
    `H${x + w - r}`,
    `Q${x + w},${top} ${x + w},${top + r}`,
    `V${baseline}`,
    'Z',
  ].join(' ');
}

/** A round axis maximum (1, 2, 5 × 10ⁿ, and even so ticks are whole). */
export function niceMax(value: number): number {
  if (value <= 2) return 2;
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  for (const step of [1, 2, 5, 10]) {
    const candidate = step * exp;
    if (candidate >= value && candidate % 2 === 0) return candidate;
  }
  return 20 * exp;
}
