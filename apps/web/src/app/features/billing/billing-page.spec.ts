import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import type {
  Invoice,
  SubscriptionResponse,
  WorkspacePlan,
} from '@saas-starter/shared';
import { settle } from '../../../testing/settle';
import { BillingService } from '../../core/billing.service';
import { WorkspaceService } from '../../core/workspace.service';
import { BillingPage, CHECKOUT_POLL } from './billing-page';

const SUB = '/api/billing/subscription?workspaceId=u1';
const INVOICES = '/api/billing/invoices?workspaceId=u1';

const free: SubscriptionResponse = {
  workspaceId: 'u1',
  plan: 'free',
  subscription: null,
  canOpenPortal: false,
};
const paid = (
  overrides: Partial<WorkspacePlan> = {},
): SubscriptionResponse => ({
  workspaceId: 'u1',
  plan: 'pro',
  subscription: {
    id: 'pro',
    status: 'active',
    currentPeriodEnd: '2026-12-27T12:00:00.000Z',
    cancelAtPeriodEnd: false,
    ...overrides,
  },
  canOpenPortal: true,
});
const invoice = (overrides: Partial<Invoice> = {}): Invoice => ({
  id: 'in_1',
  number: 'ABC-0001',
  status: 'paid',
  amountDue: 900,
  amountPaid: 900,
  currency: 'usd',
  createdAt: '2026-11-27T12:00:00.000Z',
  hostedInvoiceUrl: 'https://invoice.stripe.test/i/1',
  pdfUrl: 'https://invoice.stripe.test/i/1.pdf',
  ...overrides,
});

describe('BillingPage', () => {
  let http: HttpTestingController;
  let billing: {
    startCheckout: ReturnType<typeof vi.fn>;
    openPortal: ReturnType<typeof vi.fn>;
  };
  let navigate: ReturnType<typeof vi.fn>;
  const personal = signal(true);
  const workspaceId = signal<string | null>('u1');
  /** Lets the page take its next look at the synced plan. */
  let nextPoll: () => void;
  const poll = async () => {
    nextPoll();
    await settle();
  };

  beforeEach(() => {
    personal.set(true);
    workspaceId.set('u1');
    billing = {
      startCheckout: vi.fn().mockResolvedValue({ ok: true }),
      openPortal: vi.fn().mockResolvedValue({ ok: true }),
    };
    TestBed.configureTestingModule({
      imports: [BillingPage],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: BillingService, useValue: billing },
        {
          provide: WorkspaceService,
          useValue: { workspaceId, isPersonal: personal },
        },
        {
          provide: CHECKOUT_POLL,
          useValue: {
            attempts: 2,
            wait: () => new Promise<void>((resolve) => (nextPoll = resolve)),
          },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    navigate = vi
      .spyOn(TestBed.inject(Router), 'navigate')
      .mockResolvedValue(true) as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => http.verify());

  async function render(
    sub: SubscriptionResponse = free,
    invoices: Invoice[] = [],
    checkout?: string,
  ) {
    const fixture = TestBed.createComponent(BillingPage);
    if (checkout) fixture.componentRef.setInput('checkout', checkout);
    TestBed.tick();
    http.expectOne(SUB).flush(sub);
    http.expectOne(INVOICES).flush({ items: invoices });
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    return {
      fixture,
      el,
      q: (s: string) => el.querySelector<HTMLElement>(s),
    };
  }

  describe('current plan', () => {
    it('shows Free with an upgrade to Pro and no portal before a purchase', async () => {
      const { q } = await render();
      expect(q('[data-testid="current-plan"]')?.textContent).toContain(
        'Free plan',
      );
      expect(q('[data-testid="status"]')).toBeNull();
      expect(q('[data-testid="manage"]')).toBeNull();
      expect(q('[data-testid="upgrade"]')?.textContent).toContain(
        'Upgrade to Pro',
      );
      expect(q('[data-testid="no-invoices"]')).not.toBeNull();
    });

    it('shows the paid plan, its status and renewal date, and Manage billing', async () => {
      const { q } = await render(paid());
      expect(q('[data-testid="current-plan"]')?.textContent).toContain(
        'Pro plan',
      );
      expect(q('[data-testid="status"]')?.textContent).toContain('Active');
      expect(q('[data-testid="renewal"]')?.textContent).toContain(
        'Renews on December 27, 2026',
      );
      expect(q('[data-testid="upgrade-card"]')).toBeNull();
      expect(q('[data-testid="manage"]')).not.toBeNull();
    });

    it('says when a canceled subscription ends', async () => {
      const { q } = await render(paid({ cancelAtPeriodEnd: true }));
      expect(q('[data-testid="renewal"]')?.textContent).toContain(
        'Ends on December 27, 2026',
      );
    });

    it('warns about a failed payment', async () => {
      const { q } = await render(paid({ status: 'past_due' }));
      expect(q('[data-testid="status"]')?.textContent).toContain('Past due');
      expect(q('[data-testid="past-due"]')?.textContent).toContain(
        'Your last payment failed',
      );
    });

    it('offers Team (not Pro) in a team workspace', async () => {
      personal.set(false);
      const { fixture, q } = await render();
      q('[data-testid="upgrade"]')?.click();
      await fixture.whenStable();
      expect(billing.startCheckout).toHaveBeenCalledWith({
        workspaceId: 'u1',
        plan: 'team',
      });
    });

    it('tells non-owners that billing belongs to the owner', async () => {
      const fixture = TestBed.createComponent(BillingPage);
      TestBed.tick();
      http.expectOne(SUB).flush({}, { status: 403, statusText: 'Forbidden' });
      http
        .expectOne(INVOICES)
        .flush({}, { status: 403, statusText: 'Forbidden' });
      await fixture.whenStable();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="not-owner"]')).not.toBeNull();
      expect(el.querySelector('[data-testid="invoice-table"]')).toBeNull();
    });

    it('shows a retry when the plan fails to load', async () => {
      const fixture = TestBed.createComponent(BillingPage);
      TestBed.tick();
      http.expectOne(SUB).flush('boom', { status: 500, statusText: 'Error' });
      http.expectOne(INVOICES).flush({ items: [] });
      await fixture.whenStable();
      const el = fixture.nativeElement as HTMLElement;
      el.querySelector<HTMLElement>(
        '[data-testid="load-error"] button',
      )?.click();
      TestBed.tick();
      http.expectOne(SUB).flush(free);
      await fixture.whenStable();
      expect(el.querySelector('[data-testid="current-plan"]')).not.toBeNull();
    });
  });

  describe('actions', () => {
    it('starts Checkout for Pro', async () => {
      const { fixture, q } = await render();
      q('[data-testid="upgrade"]')?.click();
      await fixture.whenStable();
      expect(billing.startCheckout).toHaveBeenCalledWith({
        workspaceId: 'u1',
        plan: 'pro',
      });
      expect(q('[data-testid="upgrade"]')?.textContent).toContain(
        'Redirecting…',
      );
    });

    it('opens the portal', async () => {
      const { fixture, q } = await render(paid());
      q('[data-testid="manage"]')?.click();
      await fixture.whenStable();
      expect(billing.openPortal).toHaveBeenCalledWith({ workspaceId: 'u1' });
    });

    it('explains a failure and lets you try again', async () => {
      billing.startCheckout.mockResolvedValueOnce({
        ok: false,
        code: 'already_subscribed',
      });
      const { fixture, q } = await render();
      q('[data-testid="upgrade"]')?.click();
      await settle();
      await fixture.whenStable();
      expect(q('[data-testid="action-error"]')?.textContent).toContain(
        'already subscribed',
      );
      expect(q('[data-testid="upgrade"]')?.textContent).toContain(
        'Upgrade to Pro',
      );
    });
  });

  describe('more actions and states', () => {
    it('explains the portal before a first purchase, and generic failures', async () => {
      billing.openPortal.mockResolvedValueOnce({
        ok: false,
        code: 'no_billing_account',
      });
      const { fixture, q } = await render(paid());
      q('[data-testid="manage"]')?.click();
      await settle();
      await fixture.whenStable();
      expect(q('[data-testid="action-error"]')?.textContent).toContain(
        'nothing to manage yet',
      );

      billing.openPortal.mockResolvedValueOnce({ ok: false, code: 'unknown' });
      q('[data-testid="manage"]')?.click();
      await settle();
      await fixture.whenStable();
      expect(q('[data-testid="action-error"]')?.textContent).toContain(
        'Couldn’t open the billing portal',
      );
    });

    it('explains a generic checkout failure', async () => {
      billing.startCheckout.mockResolvedValueOnce({
        ok: false,
        code: 'unknown',
      });
      const { fixture, q } = await render();
      q('[data-testid="upgrade"]')?.click();
      await settle();
      await fixture.whenStable();
      expect(q('[data-testid="action-error"]')?.textContent).toContain(
        'Couldn’t start checkout',
      );
    });

    it('makes the buttons usable again when the page comes back from the bfcache', async () => {
      const { fixture, q } = await render();
      q('[data-testid="upgrade"]')?.click();
      await settle();
      await fixture.whenStable();
      expect(q('[data-testid="upgrade"]')?.textContent).toContain(
        'Redirecting…',
      );

      window.dispatchEvent(
        Object.assign(new Event('pageshow'), { persisted: true }),
      );
      await fixture.whenStable();
      expect(q('[data-testid="upgrade"]')?.textContent).toContain(
        'Upgrade to Pro',
      );
    });

    it('shows the skeleton (not a Free plan) until the workspace is known', async () => {
      workspaceId.set(null);
      const fixture = TestBed.createComponent(BillingPage);
      await fixture.whenStable();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="loading"]')).not.toBeNull();
      expect(el.querySelector('[data-testid="current-plan"]')).toBeNull();
    });
  });

  describe('invoices', () => {
    it('lists invoices with amounts and links to the Stripe-hosted pages', async () => {
      const { el } = await render(paid(), [
        invoice(),
        invoice({
          id: 'in_2',
          number: 'ABC-0002',
          status: 'open',
          amountPaid: 0,
          amountDue: 2900,
        }),
        invoice({
          id: 'in_3',
          number: null,
          currency: 'jpy',
          amountPaid: 1500,
        }),
      ]);
      const rows = el.querySelectorAll(
        '[data-testid="invoice-table"] tbody tr',
      );
      expect(rows).toHaveLength(3);
      expect(rows[0].textContent).toContain('ABC-0001');
      expect(rows[0].textContent).toContain('$9.00');
      expect(rows[0].textContent).toContain('Paid');
      expect(rows[1].textContent).toContain('$29.00'); // amount due when open
      expect(rows[1].textContent).toContain('Open');
      expect(rows[2].textContent).toContain('1,500'); // yen have no minor unit
      const link = rows[0].querySelector<HTMLAnchorElement>(
        '[data-testid="invoice-link"]',
      );
      expect(link?.href).toBe('https://invoice.stripe.test/i/1');
      expect(link?.target).toBe('_blank');
      expect(link?.rel).toContain('noopener');
    });

    it('shows a retry when invoices fail', async () => {
      const fixture = TestBed.createComponent(BillingPage);
      TestBed.tick();
      http.expectOne(SUB).flush(paid());
      http
        .expectOne(INVOICES)
        .flush('boom', { status: 502, statusText: 'Bad' });
      await fixture.whenStable();
      expect(
        (fixture.nativeElement as HTMLElement).querySelector(
          '[data-testid="invoices-error"]',
        ),
      ).not.toBeNull();
    });
  });

  describe('return from Checkout', () => {
    it('waits for the webhook-synced plan, then confirms it', async () => {
      const { fixture, q } = await render(free, [], 'success');
      expect(q('[data-testid="return-activating"]')).not.toBeNull();
      expect(q('[data-testid="upgrade-card"]')).toBeNull(); // no second purchase
      expect(navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({
          queryParams: { checkout: null },
          replaceUrl: true,
        }),
      );

      await poll(); // the webhook has landed by now
      TestBed.tick();
      http.expectOne(SUB).flush(paid());
      await fixture.whenStable();
      expect(q('[data-testid="return-activated"]')?.textContent).toContain(
        'You’re on Pro',
      );

      await poll(); // the first invoice arrives with the payment
      TestBed.tick();
      http.expectOne(INVOICES).flush({ items: [invoice()] });
      await fixture.whenStable();
      expect(q('[data-testid="invoice-table"]')).not.toBeNull();
    });

    it('says so when the plan takes longer than usual', async () => {
      const { fixture, q } = await render(free, [], 'success');
      await poll();
      TestBed.tick();
      http.expectOne(SUB).flush(free);
      await fixture.whenStable();
      await poll(); // second (last) attempt
      await fixture.whenStable();
      expect(q('[data-testid="return-slow"]')).not.toBeNull();
    });

    it('still confirms a webhook that lands after it stopped looking', async () => {
      const { fixture, q } = await render(free, [], 'success');
      await poll(); // first look: the plan is fetched again…
      TestBed.tick();
      const late = http.expectOne(SUB);
      await poll(); // …and that was the last attempt
      TestBed.tick(); // (not whenStable: the late request is still open)
      expect(q('[data-testid="return-slow"]')).not.toBeNull();

      late.flush(paid());
      await settle();
      TestBed.tick(); // (not whenStable: the invoice reload starts right away)
      TestBed.tick();
      expect(q('[data-testid="return-activated"]')).not.toBeNull();
      // …and its invoice is fetched too.
      http.expectOne(INVOICES).flush({ items: [invoice()] });
      await fixture.whenStable();
      expect(q('[data-testid="invoice-table"]')).not.toBeNull();
    });

    it('belongs to its workspace: switching clears it and stops looking', async () => {
      const { fixture, q } = await render(free, [], 'success');
      workspaceId.set('t1');
      TestBed.tick();
      http
        .expectOne('/api/billing/subscription?workspaceId=t1')
        .flush({ ...paid(), workspaceId: 't1', plan: 'team' });
      http
        .expectOne('/api/billing/invoices?workspaceId=t1')
        .flush({ items: [] });
      await fixture.whenStable();
      expect(q('[role="status"]')?.textContent?.trim()).toBe('');

      await poll();
      TestBed.tick();
      http.expectNone((r) => r.url.includes('/subscription')); // no more looking
    });

    it('stops looking when the page is left', async () => {
      const { fixture } = await render(free, [], 'success');
      fixture.destroy();
      await poll();
      TestBed.tick();
      http.expectNone(SUB); // verified again in afterEach
    });

    it('confirms a canceled Checkout without polling', async () => {
      const { fixture, q } = await render(free, [], 'canceled');
      expect(q('[data-testid="return-canceled"]')?.textContent).toContain(
        'haven’t been charged',
      );
      q('[data-testid="return-canceled"] button')?.click();
      await settle();
      await fixture.whenStable();
      expect(q('[data-testid="return-canceled"]')).toBeNull();
    });

    it('ignores unknown values', async () => {
      const { q } = await render(free, [], 'whatever');
      expect(q('[role="status"]')?.textContent?.trim()).toBe('');
      expect(navigate).not.toHaveBeenCalled();
    });
  });
});
