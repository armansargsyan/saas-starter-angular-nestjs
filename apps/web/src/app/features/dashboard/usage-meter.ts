import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { PLANS, type UsageResponse } from '@saas-starter/shared';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmProgressImports } from '@spartan-ng/helm/progress';
import { BillingService } from '../../core/billing.service';

/**
 * Links used vs the plan's limit (computed by the api; the UI only shows
 * it), with an upgrade prompt when the limit is reached.
 */
@Component({
  selector: 'app-usage-meter',
  imports: [RouterLink, HlmButtonImports, HlmCardImports, HlmProgressImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (usage(); as u) {
      <section
        hlmCard
        size="sm"
        aria-labelledby="usage-title"
        data-testid="usage"
      >
        <div hlmCardContent class="grid gap-3">
          <div class="flex items-baseline justify-between gap-4">
            <h2 id="usage-title" class="text-sm font-medium">
              {{ planName() }} plan · links
            </h2>
            <p
              class="text-muted-foreground text-sm tabular-nums"
              data-testid="usage-text"
            >
              @if (u.links.limit === null) {
                {{ u.links.used }} used · unlimited
              } @else {
                {{ u.links.used }} of {{ u.links.limit }} used
              }
            </p>
          </div>
          @if (u.links.limit !== null) {
            <!-- The indicator draws value as a percentage (it ignores max). -->
            <hlm-progress
              [value]="percent()"
              [getValueLabel]="valueLabel"
              aria-labelledby="usage-title"
              class="h-2"
            >
              <hlm-progress-indicator />
            </hlm-progress>
          }
          @if (atLimit()) {
            <div
              class="bg-muted flex flex-col gap-3 rounded-lg p-3 sm:flex-row sm:items-center"
              data-testid="upgrade-prompt"
            >
              <p class="flex-1 text-sm">
                You’ve reached the {{ planName() }} limit of
                {{ u.links.limit }} links. Existing links keep working; upgrade
                to create more.
              </p>
              @if (canUpgradePersonal()) {
                <button
                  hlmBtn
                  size="sm"
                  type="button"
                  class="aria-disabled:opacity-60"
                  [attr.aria-disabled]="upgrading() ? 'true' : null"
                  [attr.aria-busy]="upgrading()"
                  (click)="upgrade()"
                  data-testid="upgrade"
                >
                  {{
                    upgrading()
                      ? 'Redirecting…'
                      : 'Upgrade to Pro · $' + pro.priceMonthlyUsd + '/mo'
                  }}
                </button>
              } @else {
                <a hlmBtn size="sm" routerLink="/billing">See plans</a>
              }
            </div>
            <div role="alert">
              @if (upgradeError()) {
                <p class="text-destructive text-sm">{{ upgradeError() }}</p>
              }
            </div>
          }
        </div>
      </section>
    }
  `,
})
export class UsageMeter {
  private readonly billing = inject(BillingService);

  readonly usage = input<UsageResponse | undefined>();
  readonly workspaceId = input.required<string>();
  /** Personal workspaces upgrade to Pro here; teams upgrade from Billing. */
  readonly personal = input(true);

  protected readonly pro = PLANS.pro;
  protected readonly upgrading = signal(false);
  protected readonly upgradeError = signal('');

  protected readonly planName = computed(
    () => PLANS[this.usage()?.plan ?? 'free'].name,
  );
  protected readonly atLimit = computed(() => {
    const links = this.usage()?.links;
    return !!links && links.limit !== null && links.used >= links.limit;
  });
  protected readonly percent = computed(() => {
    const links = this.usage()?.links;
    if (!links || !links.limit) return 0;
    return Math.min(100, Math.round((links.used / links.limit) * 100));
  });
  protected readonly valueLabel = () => {
    const links = this.usage()?.links;
    return links && links.limit !== null
      ? `${links.used} of ${links.limit} links used`
      : '';
  };

  protected readonly canUpgradePersonal = computed(
    () => this.personal() && this.usage()?.plan === 'free',
  );

  protected async upgrade(): Promise<void> {
    if (this.upgrading()) return;
    this.upgrading.set(true);
    this.upgradeError.set('');
    const outcome = await this.billing.startCheckout({
      workspaceId: this.workspaceId(),
      plan: 'pro',
    });
    if (!outcome.ok) {
      this.upgrading.set(false);
      this.upgradeError.set(
        outcome.code === 'already_subscribed'
          ? 'You’re already subscribed: it can take a moment to show up.'
          : 'Couldn’t start checkout. Please try again.',
      );
    }
  }
}
