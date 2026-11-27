import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Placeholder: the billing page arrives in #12. */
@Component({
  selector: 'app-billing-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-2xl font-semibold tracking-tight">Billing</h1>
    <p class="text-muted-foreground mt-2">
      Plans, payment and invoices are coming soon.
    </p>
  `,
})
export class BillingPage {}
