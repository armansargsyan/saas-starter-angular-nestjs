import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { PLANS } from '@saas-starter/shared';
import { FakeAuth } from '../../../testing/fake-auth';
import { settle } from '../../../testing/settle';
import { authInterceptor } from '../../core/auth.interceptor';
import { AuthService } from '../../core/auth.service';
import { Navigator } from '../../core/navigator';
import { PricingTable } from './pricing-table';

describe('PricingTable', () => {
  let auth: FakeAuth;
  let http: HttpTestingController;
  let navigator: { assign: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    auth = new FakeAuth();
    navigator = { assign: vi.fn() };
    TestBed.configureTestingModule({
      imports: [PricingTable],
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: auth },
        { provide: Navigator, useValue: navigator },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function render() {
    const fixture = TestBed.createComponent(PricingTable);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const q = (id: string) =>
      el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    return { fixture, el, q };
  }

  it('renders Free, Pro and Team from the shared plan definitions', async () => {
    const { q } = await render();

    for (const id of ['free', 'pro', 'team'] as const) {
      const card = q(`plan-${id}`);
      expect(card?.textContent).toContain(PLANS[id].name);
      expect(
        card?.querySelector('[data-testid="price"]')?.textContent?.trim(),
      ).toBe(`$${PLANS[id].priceMonthlyUsd}`);
      for (const feature of PLANS[id].features)
        expect(card?.textContent).toContain(feature);
    }
  });

  it('sends signed-out visitors to sign up, keeping the plan', async () => {
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const { q } = await render();

    expect(q('cta-pro')?.textContent).toContain('Start with Pro');
    q('cta-pro')?.click();
    await Promise.resolve();
    expect(navigate).toHaveBeenCalledWith(['/signup'], {
      queryParams: { plan: 'pro' },
    });

    q('cta-free')?.click();
    expect(navigate).toHaveBeenLastCalledWith(['/signup'], {});
  });

  it('starts Stripe Checkout for Pro when signed in, with the bearer token', async () => {
    auth.signIn('u1');
    const { fixture, q } = await render();
    expect(q('cta-pro')?.textContent).toContain('Upgrade to Pro');

    q('cta-pro')?.click();
    await fixture.whenStable();
    await settle();
    const req = http.expectOne('/api/billing/checkout');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ workspaceId: 'u1', plan: 'pro' });
    expect(req.request.headers.get('Authorization')).toBe('Bearer test-token');
    req.flush({ url: 'https://checkout.stripe.test/s' });
    await fixture.whenStable();

    expect(navigator.assign).toHaveBeenCalledWith(
      'https://checkout.stripe.test/s',
    );
  });

  it('explains when the user is already subscribed', async () => {
    auth.signIn('u1');
    const { fixture, q, el } = await render();

    q('cta-pro')?.click();
    await settle();
    http
      .expectOne('/api/billing/checkout')
      .flush(
        { code: 'already_subscribed' },
        { status: 409, statusText: 'Conflict' },
      );
    await settle();
    await fixture.whenStable();

    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'already have a paid plan',
    );
    expect(navigator.assign).not.toHaveBeenCalled();
    expect(q('cta-pro')?.getAttribute('aria-disabled')).toBeNull();
    expect(el.querySelector('[role="alert"] a')?.getAttribute('href')).toBe(
      '/billing',
    );
  });

  it('sends signed-in users to their dashboard or to create a team', async () => {
    auth.signIn('u1');
    const navigate = vi
      .spyOn(TestBed.inject(Router), 'navigate')
      .mockResolvedValue(true);
    const { q } = await render();

    q('cta-free')?.click();
    expect(navigate).toHaveBeenCalledWith(['/dashboard']);
    q('cta-team')?.click();
    expect(navigate).toHaveBeenLastCalledWith(['/teams'], {
      queryParams: { new: 1 },
    });
  });

  it('keeps CTAs hidden and inert until the session is known', async () => {
    auth.state.set(undefined);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
    const { q } = await render();

    expect(q('cta-pro')?.classList).toContain('invisible');
    expect(q('cta-pro')?.getAttribute('aria-disabled')).toBe('true');
    q('cta-pro')?.click();
    await settle();
    expect(navigate).not.toHaveBeenCalled();
    http.expectNone('/api/billing/checkout');
  });

  it('shows a generic message when checkout fails for another reason', async () => {
    auth.signIn('u1');
    const { fixture, q, el } = await render();
    const button = q('cta-pro') as HTMLButtonElement;
    button.focus();

    button.click();
    await settle();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(button); // focus isn't dropped
    http.expectOne('/api/billing/checkout').error(new ProgressEvent('error'));
    await settle();
    await fixture.whenStable();

    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'Couldn’t start checkout',
    );
    expect(el.querySelector('[role="alert"] a')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('re-enables the buttons when the page comes back from Stripe (bfcache)', async () => {
    auth.signIn('u1');
    const { fixture, q } = await render();
    q('cta-pro')?.click();
    await settle();
    http
      .expectOne('/api/billing/checkout')
      .flush({ url: 'https://checkout.stripe.test/s' });
    await settle();
    await fixture.whenStable();
    expect(q('cta-pro')?.textContent).toContain('Redirecting');

    window.dispatchEvent(
      new PageTransitionEvent('pageshow', { persisted: true }),
    );
    await fixture.whenStable();

    expect(q('cta-pro')?.textContent).toContain('Upgrade to Pro');
    expect(q('cta-pro')?.getAttribute('aria-disabled')).toBeNull();
  });
});
