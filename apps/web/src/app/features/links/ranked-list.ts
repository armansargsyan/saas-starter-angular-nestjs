import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

export interface RankedItem {
  label: string;
  count: number;
}

/**
 * A ranked list with inline bars (one hue): names and values are text, the
 * bar only shows relative size, so nothing depends on reading the color.
 */
@Component({
  selector: 'app-ranked-list',
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (items().length === 0) {
      <p class="text-muted-foreground text-sm">{{ empty() }}</p>
    } @else {
      <ol class="grid gap-2" [attr.aria-label]="label()">
        @for (item of items(); track item.label) {
          <li class="grid gap-1 text-sm">
            <div class="flex justify-between gap-3">
              <span class="truncate" [title]="item.label">{{
                item.label
              }}</span>
              <span class="tabular-nums">{{ item.count | number }}</span>
            </div>
            <div
              class="bg-muted h-2 overflow-hidden rounded-full"
              aria-hidden="true"
            >
              <div
                class="h-full rounded-full bg-(--chart-series)"
                [style.width.%]="(item.count / max()) * 100"
              ></div>
            </div>
          </li>
        }
      </ol>
    }
  `,
})
export class RankedList {
  readonly items = input.required<RankedItem[]>();
  readonly label = input.required<string>();
  readonly empty = input('No data yet.');
  protected readonly max = computed(() =>
    Math.max(1, ...this.items().map((i) => i.count)),
  );
}
