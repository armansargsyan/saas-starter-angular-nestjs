import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChartColumn,
  lucideCreditCard,
  lucideLink,
  lucideShieldCheck,
  lucideUserCog,
  lucideUsers,
} from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { AuthService } from '../../core/auth.service';
import { SiteHeader } from '../../layout/site-header';
import { PricingTable } from '../pricing/pricing-table';

const FEATURES = [
  {
    icon: 'lucideLink',
    title: 'Short links, your way',
    body: 'Random 7-character codes or your own slugs. Deleted codes are never reissued, so printed links can’t be hijacked.',
  },
  {
    icon: 'lucideChartColumn',
    title: 'Click analytics',
    body: 'Clicks per day, top referrers, countries and devices. Bots are counted separately and IPs are never stored.',
  },
  {
    icon: 'lucideUsers',
    title: 'Teams',
    body: 'Invite people by email, share links and analytics, with owner, admin and member roles.',
  },
  {
    icon: 'lucideCreditCard',
    title: 'Stripe billing',
    body: 'Checkout, the customer portal and invoices. Plans sync from signed webhooks, never from the browser.',
  },
  {
    icon: 'lucideUserCog',
    title: 'Admin panel',
    body: 'Users, revenue stats, bans and read-only impersonation, with every action audit-logged.',
  },
  {
    icon: 'lucideShieldCheck',
    title: 'Secure by default',
    body: 'Limits enforced on the server in transactions, verified tokens on every request, rate limits on abuse paths.',
  },
] as const;

@Component({
  selector: 'app-landing-page',
  imports: [
    RouterLink,
    NgIcon,
    HlmButtonImports,
    HlmCardImports,
    SiteHeader,
    PricingTable,
  ],
  providers: [
    provideIcons({
      lucideLink,
      lucideChartColumn,
      lucideUsers,
      lucideCreditCard,
      lucideUserCog,
      lucideShieldCheck,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './landing-page.html',
})
export class LandingPage {
  protected readonly auth = inject(AuthService);
  protected readonly features = FEATURES;
}
