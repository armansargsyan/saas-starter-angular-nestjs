import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  ApiErrorBody,
  CheckoutRequest,
  PortalRequest,
  RedirectUrlResponse,
} from '@saas-starter/shared';
import { firstValueFrom } from 'rxjs';
import { Navigator } from './navigator';

export type RedirectOutcome =
  { ok: true } | { ok: false; code: ApiErrorBody['code'] | 'unknown' };

/** Starting Checkout or the portal; both end with the browser on Stripe. */
@Injectable({ providedIn: 'root' })
export class BillingService {
  private readonly http = inject(HttpClient);
  private readonly navigator = inject(Navigator);

  /** Creates a Checkout Session and sends the browser to Stripe. */
  startCheckout(body: CheckoutRequest): Promise<RedirectOutcome> {
    return this.redirect('/api/billing/checkout', body);
  }

  /** Opens the Stripe billing portal (payment method, cancel, invoices). */
  openPortal(body: PortalRequest): Promise<RedirectOutcome> {
    return this.redirect('/api/billing/portal', body);
  }

  private async redirect(
    path: string,
    body: CheckoutRequest | PortalRequest,
  ): Promise<RedirectOutcome> {
    try {
      const { url } = await firstValueFrom(
        this.http.post<RedirectUrlResponse>(path, body),
      );
      this.navigator.assign(url);
      return { ok: true };
    } catch (err) {
      const code =
        err instanceof HttpErrorResponse
          ? (err.error as Partial<ApiErrorBody> | null)?.code
          : undefined;
      return { ok: false, code: code ?? 'unknown' };
    }
  }
}
