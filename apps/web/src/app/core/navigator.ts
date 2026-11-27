import { DOCUMENT, inject, Injectable } from '@angular/core';

/** Full-page navigation to another origin (e.g. Stripe Checkout); swappable in tests. */
@Injectable({ providedIn: 'root' })
export class Navigator {
  private readonly document = inject(DOCUMENT);

  assign(url: string): void {
    this.document.location.assign(url);
  }
}
