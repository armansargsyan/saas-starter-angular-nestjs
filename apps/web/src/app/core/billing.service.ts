import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  ApiErrorBody,
  CheckoutRequest,
  RedirectUrlResponse,
} from '@saas-starter/shared';
import { firstValueFrom } from 'rxjs';
import { Navigator } from './navigator';

export type CheckoutOutcome =
  { ok: true } | { ok: false; code: ApiErrorBody['code'] | 'unknown' };

@Injectable({ providedIn: 'root' })
export class BillingService {
  private readonly http = inject(HttpClient);
  private readonly navigator = inject(Navigator);

  /** Creates a Checkout Session and sends the browser to Stripe. */
  async startCheckout(body: CheckoutRequest): Promise<CheckoutOutcome> {
    try {
      const { url } = await firstValueFrom(
        this.http.post<RedirectUrlResponse>('/api/billing/checkout', body),
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
