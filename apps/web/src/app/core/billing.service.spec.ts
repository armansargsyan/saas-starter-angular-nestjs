import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { settle } from '../../testing/settle';
import { BillingService } from './billing.service';
import { Navigator } from './navigator';

describe('BillingService', () => {
  let http: HttpTestingController;
  let service: BillingService;
  const assign = vi.fn();

  beforeEach(() => {
    assign.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: Navigator, useValue: { assign } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(BillingService);
  });

  afterEach(() => http.verify());

  it('sends the browser to Checkout', async () => {
    const outcome = service.startCheckout({ workspaceId: 'u1', plan: 'pro' });
    const req = http.expectOne('/api/billing/checkout');
    expect(req.request.body).toEqual({ workspaceId: 'u1', plan: 'pro' });
    req.flush({ url: 'https://checkout.stripe.test/s' });
    expect(await outcome).toEqual({ ok: true });
    expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/s');
  });

  it('sends the browser to the portal', async () => {
    const outcome = service.openPortal({ workspaceId: 'u1' });
    http
      .expectOne('/api/billing/portal')
      .flush({ url: 'https://billing.stripe.test/p' });
    expect(await outcome).toEqual({ ok: true });
    expect(assign).toHaveBeenCalledWith('https://billing.stripe.test/p');
  });

  it('returns the api error code and stays on the page', async () => {
    const outcome = service.openPortal({ workspaceId: 'u1' });
    http
      .expectOne('/api/billing/portal')
      .flush(
        { code: 'no_billing_account', message: 'x' },
        { status: 409, statusText: 'Conflict' },
      );
    expect(await outcome).toEqual({ ok: false, code: 'no_billing_account' });
    await settle();
    expect(assign).not.toHaveBeenCalled();
  });

  it('falls back to "unknown" without an api error code', async () => {
    const outcome = service.startCheckout({ workspaceId: 'u1', plan: 'pro' });
    http
      .expectOne('/api/billing/checkout')
      .flush('Bad gateway', { status: 502, statusText: 'Bad Gateway' });
    expect(await outcome).toEqual({ ok: false, code: 'unknown' });
  });

  it('falls back to "unknown" when leaving for Stripe fails', async () => {
    assign.mockImplementationOnce(() => {
      throw new Error('blocked');
    });
    const outcome = service.openPortal({ workspaceId: 'u1' });
    http
      .expectOne('/api/billing/portal')
      .flush({ url: 'https://billing.stripe.test/p' });
    expect(await outcome).toEqual({ ok: false, code: 'unknown' });
  });
});
