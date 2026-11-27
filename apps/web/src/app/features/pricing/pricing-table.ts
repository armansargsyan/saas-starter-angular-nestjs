import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck } from '@ng-icons/lucide';
import {
  type ApiErrorCode,
  type PlanDefinition,
  type PlanId,
  PLAN_IDS,
  PLANS,
} from '@saas-starter/shared';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { AuthService } from '../../core/auth.service';
import { BillingService } from '../../core/billing.service';

interface PlanCard {
  plan: PlanDefinition;
  highlighted: boolean;
  cta: string;
}

/** Known failures; `billingLink` adds a link to the Billing page. */
const MESSAGES: Partial<
  Record<ApiErrorCode, { text: string; billingLink?: boolean }>
> = {
  already_subscribed: {
    text: 'You already have a paid plan.',
    billingLink: true,
  },
};

/**
 * Plans straight from the shared definitions, so the page can't disagree
 * with what the api enforces. Signed out, CTAs go to sign up (keeping the
 * chosen plan); signed in, Pro goes to Stripe Checkout and Team to creating
 * a team (Team is bought for a team workspace).
 */
@Component({
  selector: 'app-pricing-table',
  imports: [
    RouterLink,
    NgIcon,
    HlmBadgeImports,
    HlmButtonImports,
    HlmCardImports,
  ],
  providers: [provideIcons({ lucideCheck })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './pricing-table.html',
})
export class PricingTable {
  private readonly auth = inject(AuthService);
  private readonly billing = inject(BillingService);
  private readonly router = inject(Router);

  /** Until the session is known, CTAs keep their space but stay hidden and inert. */
  protected readonly ready = this.auth.ready;
  protected readonly busy = signal<PlanId | null>(null);
  protected readonly error = signal<{
    text: string;
    billingLink?: boolean;
  } | null>(null);

  constructor() {
    // Back from Stripe via the back/forward cache: the page is restored as
    // it was ("Redirecting…"), so make the buttons usable again.
    const document = inject(DOCUMENT);
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) this.busy.set(null);
    };
    document.defaultView?.addEventListener('pageshow', onPageShow);
    inject(DestroyRef).onDestroy(() =>
      document.defaultView?.removeEventListener('pageshow', onPageShow),
    );
  }

  protected readonly cards = computed<PlanCard[]>(() => {
    const signedIn = this.auth.signedIn();
    return PLAN_IDS.map((id) => ({
      plan: PLANS[id],
      highlighted: id === 'pro',
      cta: ctaLabel(id, signedIn),
    }));
  });

  protected async choose(id: PlanId): Promise<void> {
    // Inert while the session is unknown or a checkout is starting (the
    // button stays focusable via aria-disabled, so focus isn't lost).
    if (!this.auth.ready() || this.busy() !== null) return;
    this.error.set(null);
    if (!this.auth.signedIn()) {
      await this.router.navigate(
        ['/signup'],
        id === 'free' ? {} : { queryParams: { plan: id } },
      );
      return;
    }
    if (id === 'free') {
      await this.router.navigate(['/dashboard']);
      return;
    }
    if (id === 'team') {
      await this.router.navigate(['/teams'], { queryParams: { new: 1 } });
      return;
    }
    const uid = this.auth.user()?.uid;
    if (!uid) return;
    this.busy.set(id);
    const outcome = await this.billing.startCheckout({
      workspaceId: uid,
      plan: 'pro',
    });
    // On success the browser is already leaving for Stripe.
    if (!outcome.ok) {
      this.busy.set(null);
      this.error.set(
        (outcome.code !== 'unknown' && MESSAGES[outcome.code]) || {
          text: 'Couldn’t start checkout. Please try again.',
        },
      );
    }
  }
}

function ctaLabel(id: PlanId, signedIn: boolean): string {
  if (!signedIn)
    return id === 'free' ? 'Start for free' : `Start with ${PLANS[id].name}`;
  switch (id) {
    case 'free':
      return 'Go to dashboard';
    case 'pro':
      return 'Upgrade to Pro';
    default:
      return 'Create a team';
  }
}
