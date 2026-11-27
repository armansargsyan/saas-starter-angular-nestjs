import { DatePipe } from '@angular/common';
import { HttpErrorResponse, httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  effect,
  inject,
  InjectionToken,
  input,
  OnInit,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideExternalLink, lucideX } from '@ng-icons/lucide';
import {
  type Invoice,
  type InvoiceListResponse,
  type PaidPlanId,
  type PlanDefinition,
  PLANS,
  type PlanStatus,
  type SubscriptionResponse,
} from '@saas-starter/shared';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmSkeletonImports } from '@spartan-ng/helm/skeleton';
import {
  BillingService,
  type RedirectOutcome,
} from '../../core/billing.service';
import { WorkspaceService } from '../../core/workspace.service';

/** Waiting for the webhook after a successful Checkout (~30 s by default). */
export const CHECKOUT_POLL = new InjectionToken<{
  attempts: number;
  /** Resolves when it's time for the next look at the synced plan. */
  wait: () => Promise<void>;
}>('CHECKOUT_POLL', {
  factory: () => ({
    attempts: 15,
    wait: () => new Promise((resolve) => setTimeout(resolve, 2000)),
  }),
});

type CheckoutReturn = 'activating' | 'activated' | 'slow' | 'canceled' | null;

const STATUS_LABELS: Record<PlanStatus, string> = {
  active: 'Active',
  trialing: 'Trial',
  past_due: 'Past due',
  canceled: 'Canceled',
  unpaid: 'Unpaid',
  incomplete: 'Incomplete',
  incomplete_expired: 'Expired',
  paused: 'Paused',
};

@Component({
  selector: 'app-billing-page',
  imports: [
    DatePipe,
    NgIcon,
    HlmAlertImports,
    HlmBadgeImports,
    HlmButtonImports,
    HlmCardImports,
    HlmSkeletonImports,
  ],
  providers: [provideIcons({ lucideCheck, lucideExternalLink, lucideX })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './billing-page.html',
})
export class BillingPage implements OnInit {
  private readonly billing = inject(BillingService);
  private readonly router = inject(Router);
  private readonly poll = inject(CHECKOUT_POLL);
  private readonly workspaces = inject(WorkspaceService);

  /** `?checkout=success|canceled`, set by Stripe's return URLs. */
  readonly checkout = input<string>();

  protected readonly workspaceId = this.workspaces.workspaceId;
  protected readonly personal = this.workspaces.isPersonal;

  protected readonly sub = httpResource<SubscriptionResponse>(() => {
    const ws = this.workspaceId();
    return ws
      ? `/api/billing/subscription?workspaceId=${encodeURIComponent(ws)}`
      : undefined;
  });
  protected readonly invoices = httpResource<InvoiceListResponse>(() => {
    const ws = this.workspaceId();
    return ws
      ? `/api/billing/invoices?workspaceId=${encodeURIComponent(ws)}`
      : undefined;
  });

  /** `value()` throws while a resource is in an error state: read through these. */
  protected readonly subValue = computed(() =>
    this.sub.hasValue() ? this.sub.value() : undefined,
  );
  /** Invoice rows with their labels worked out once, not on every render. */
  protected readonly invoiceRows = computed(() =>
    (this.invoices.hasValue() ? this.invoices.value().items : []).map(
      (invoice) => ({
        ...invoice,
        amountLabel: formatAmount(invoice),
        statusLabel: capitalize(invoice.status ?? 'draft'),
      }),
    ),
  );
  /** Billing belongs to the workspace owner (the api answers 403). */
  protected readonly notOwner = computed(() => {
    const err = this.sub.error();
    return err instanceof HttpErrorResponse && err.status === 403;
  });

  protected readonly plan = computed(
    () => PLANS[this.subValue()?.plan ?? 'free'],
  );
  protected readonly subscription = computed(
    () => this.subValue()?.subscription ?? null,
  );
  protected readonly isPaid = computed(() => this.plan().id !== 'free');
  protected readonly statusLabel = computed(() => {
    const s = this.subscription();
    return s && this.isPaid() ? STATUS_LABELS[s.status] : null;
  });
  protected readonly pastDue = computed(
    () => this.isPaid() && this.subscription()?.status === 'past_due',
  );
  /**
   * Pro is sold to personal workspaces, Team to team workspaces. Hidden while
   * a Checkout that just finished is still being synced.
   */
  protected readonly upgradeTo = computed<
    (PlanDefinition & { id: PaidPlanId }) | null
  >(() => {
    const pending = this.checkoutReturn();
    if (this.isPaid() || pending === 'activating' || pending === 'slow') {
      return null;
    }
    const id: PaidPlanId = this.personal() ? 'pro' : 'team';
    return { ...PLANS[id], id };
  });

  private readonly returnState = signal<CheckoutReturn>(null);
  /** The workspace the Checkout was for: the message belongs to it only. */
  private returnWorkspace: string | null = null;
  /** The return from Checkout, settled as soon as the synced plan is paid. */
  protected readonly checkoutReturn = computed<CheckoutReturn>(() => {
    const state = this.returnState();
    if (this.workspaceId() !== this.returnWorkspace) return null;
    // A late webhook (even after we stopped looking) still settles it.
    return (state === 'activating' || state === 'slow') && this.isPaid()
      ? 'activated'
      : state;
  });

  protected readonly busy = signal<'checkout' | 'portal' | null>(null);
  protected readonly actionError = signal<string | null>(null);

  private destroyed = false;

  constructor() {
    // A webhook that lands after the poll gave up: its invoice is new too.
    effect(() => {
      if (
        this.returnState() === 'slow' &&
        this.checkoutReturn() === 'activated'
      ) {
        this.returnState.set('activated');
        this.invoices.reload();
      }
    });
    // Back from Stripe via the back/forward cache: the page is restored as it
    // was left, buttons still busy, so make them usable again.
    const view = inject(DOCUMENT).defaultView;
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) this.busy.set(null);
    };
    view?.addEventListener('pageshow', onPageShow);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      view?.removeEventListener('pageshow', onPageShow);
    });
  }

  ngOnInit(): void {
    const checkout = this.checkout();
    if (checkout !== 'success' && checkout !== 'canceled') return;
    this.returnWorkspace = this.workspaceId();
    this.returnState.set(checkout === 'success' ? 'activating' : 'canceled');
    // Drop the query param, so a reload doesn't replay the message.
    void this.router.navigate([], {
      queryParams: { checkout: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    if (checkout === 'success') void this.waitForPlan();
  }

  /** The webhook may land after the redirect: re-read the synced plan. */
  private async waitForPlan(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      await this.poll.wait();
      // Left the page, or switched to another workspace: stop looking.
      if (this.destroyed || this.workspaceId() !== this.returnWorkspace) return;
      if (this.checkoutReturn() !== 'activating') {
        this.invoices.reload(); // the first invoice comes with the payment
        return;
      }
      if (attempt >= this.poll.attempts) {
        this.returnState.set('slow');
        return;
      }
      this.sub.reload();
    }
  }

  protected dismissReturn(): void {
    this.returnState.set(null);
  }

  protected upgrade(plan: PaidPlanId): Promise<void> {
    return this.go('checkout', (workspaceId) =>
      this.billing.startCheckout({ workspaceId, plan }),
    );
  }

  protected manage(): Promise<void> {
    return this.go('portal', (workspaceId) =>
      this.billing.openPortal({ workspaceId }),
    );
  }

  private async go(
    action: 'checkout' | 'portal',
    start: (workspaceId: string) => Promise<RedirectOutcome>,
  ): Promise<void> {
    const ws = this.workspaceId();
    if (!ws || this.busy()) return;
    this.busy.set(action);
    this.actionError.set(null);
    const outcome = await start(ws);
    // On success the browser is leaving for Stripe: keep the button busy.
    if (outcome.ok) return;
    this.busy.set(null);
    this.actionError.set(
      outcome.code === 'already_subscribed'
        ? 'You’re already subscribed: it can take a moment to show up here.'
        : outcome.code === 'no_billing_account'
          ? 'There’s nothing to manage yet: billing starts with your first upgrade.'
          : action === 'checkout'
            ? 'Couldn’t start checkout. Please try again.'
            : 'Couldn’t open the billing portal. Please try again.',
    );
  }
}

/** Stripe amounts are in the currency's smallest unit (cents, or yen). */
function formatAmount(invoice: Invoice): string {
  const value =
    invoice.status === 'paid' ? invoice.amountPaid : invoice.amountDue;
  const format = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: invoice.currency.toUpperCase(),
  });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(value / 10 ** digits);
}

function capitalize(text: string): string {
  return text[0].toUpperCase() + text.slice(1);
}
