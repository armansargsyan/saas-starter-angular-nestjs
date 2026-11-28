import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { OVERLAY_DEFAULT_CONFIG } from '@angular/cdk/overlay';
import { provideRouter, Router } from '@angular/router';
import type { AdminUser } from '@saas-starter/shared';
import { FakeAuth } from '../../../testing/fake-auth';
import { settle } from '../../../testing/settle';
import { AuthService } from '../../core/auth.service';
import { AdminUsers } from './admin-users';

const USERS = '/api/admin/users';

const user = (uid: string, overrides: Partial<AdminUser> = {}): AdminUser => ({
  uid,
  email: `${uid}@example.com`,
  displayName: null,
  role: 'user',
  status: 'active',
  plan: 'free',
  linkCount: 3,
  createdAt: '2026-11-01T00:00:00.000Z',
  ...overrides,
});

const LIST = [
  user('admin1', { role: 'admin' }),
  user('ada', { plan: 'pro', displayName: 'Ada Lovelace' }),
  user('bob', { status: 'banned' }),
];

describe('AdminUsers', () => {
  let auth: FakeAuth;
  let http: HttpTestingController;

  beforeEach(() => {
    auth = new FakeAuth();
    auth.role.set('admin');
    auth.signIn('admin1');
    TestBed.configureTestingModule({
      imports: [AdminUsers],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: auth },
        { provide: OVERLAY_DEFAULT_CONFIG, useValue: { usePopover: false } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    document.body
      .querySelectorAll('.cdk-overlay-container')
      .forEach((n) => n.remove());
  });

  /** The pending list request (any query). */
  const listRequest = (): TestRequest =>
    http.expectOne((req) => req.url === USERS);

  async function flushList(
    fixture: { whenStable(): Promise<unknown> },
    items: AdminUser[],
    nextCursor: string | null = null,
  ) {
    const req = listRequest();
    req.flush({ items, nextCursor });
    await settle();
    await fixture.whenStable();
    return req;
  }

  async function render(items = LIST, nextCursor: string | null = null) {
    const fixture = TestBed.createComponent(AdminUsers);
    document.body.appendChild(fixture.nativeElement);
    TestBed.tick();
    const el = fixture.nativeElement as HTMLElement;
    const q = (s: string) => el.querySelector<HTMLElement>(s);
    const row = (uid: string) =>
      el.querySelector<HTMLElement>(`[data-user="${uid}"]`);
    expect(q('[data-testid="users-loading"]')).not.toBeNull();
    const req = await flushList(fixture, items, nextCursor);
    return { fixture, el, q, row, req };
  }

  const cleanup = (fixture: { nativeElement: HTMLElement }) =>
    fixture.nativeElement.remove();

  const confirm = async (
    fixture: { whenStable(): Promise<unknown> },
    trigger: HTMLElement | null | undefined,
    button: string,
  ) => {
    trigger?.click();
    await fixture.whenStable();
    const title = document.querySelector('h2[hlmAlertDialogTitle]');
    document.querySelector<HTMLElement>(`[data-testid="${button}"]`)?.click();
    await settle();
    return title?.textContent ?? '';
  };

  it('lists users with plan and status, protecting admins and yourself', async () => {
    const { fixture, row, req } = await render();
    expect(req.request.params.get('limit')).toBe('25');
    expect(req.request.params.has('q')).toBe(false);

    expect(row('ada')?.textContent).toContain('Ada Lovelace');
    expect(
      row('ada')?.querySelector('[data-testid="plan"]')?.textContent,
    ).toContain('Pro');
    expect(
      row('ada')?.querySelector('[data-testid="status"]')?.textContent,
    ).toContain('Active');
    expect(row('ada')?.querySelector('[data-testid="ban"]')).not.toBeNull();
    expect(
      row('ada')?.querySelector('[data-testid="impersonate"]'),
    ).not.toBeNull();

    expect(
      row('bob')?.querySelector('[data-testid="status"]')?.textContent,
    ).toContain('Banned');
    expect(row('bob')?.querySelector('[data-testid="unban"]')).not.toBeNull();
    expect(row('bob')?.querySelector('[data-testid="impersonate"]')).toBeNull();

    // admin1 is both an admin and me.
    expect(row('admin1')?.textContent).toContain('(you)');
    expect(
      row('admin1')?.querySelector('[data-testid="protected"]'),
    ).not.toBeNull();
    expect(row('admin1')?.querySelector('button')).toBeNull();
    cleanup(fixture);
  });

  it('protects other admins too', async () => {
    const { fixture, row } = await render([user('admin2', { role: 'admin' })]);
    expect(
      row('admin2')?.querySelector('[data-testid="protected"]')?.textContent,
    ).toContain('Admin');
    expect(row('admin2')?.querySelector('button')).toBeNull();
    cleanup(fixture);
  });

  it('searches by email prefix and shows when nothing matches', async () => {
    const { fixture, q } = await render();
    const input = q('[data-testid="user-search"]') as HTMLInputElement;
    input.value = '  Zed ';
    input.dispatchEvent(new Event('input'));
    q('[data-testid="search"]')?.click();
    TestBed.tick();
    const req = await flushList(fixture, []);
    expect(req.request.params.get('q')).toBe('Zed');
    expect(q('[data-testid="users-empty"]')?.textContent).toContain(
      'No users with an email starting with “Zed”',
    );

    q('[data-testid="clear-search"]')?.click();
    TestBed.tick();
    const all = await flushList(fixture, LIST);
    expect(all.request.params.has('q')).toBe(false);
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    cleanup(fixture);
  });

  it('pages with the cursor, and back, keeping the pager and focus while loading', async () => {
    const { fixture, q } = await render(LIST, 'bob');
    const disabled = (id: string) =>
      q(`[data-testid="${id}"]`)?.getAttribute('aria-disabled') === 'true';
    expect(disabled('previous')).toBe(true);
    expect(disabled('next')).toBe(false);
    q('[data-testid="next"]')?.click();
    TestBed.tick();
    const second = await flushList(fixture, [user('cat')]);
    expect(second.request.params.get('cursor')).toBe('bob');
    expect(q('[data-testid="page"]')?.textContent).toContain('Page 2');
    expect(disabled('next')).toBe(true);
    // An unavailable page is ignored (aria-disabled keeps the button focusable).
    q('[data-testid="next"]')?.click();
    TestBed.tick();
    http.expectNone((req) => req.url === USERS);

    const previous = q('[data-testid="previous"]') as HTMLElement;
    previous.focus();
    previous.click();
    TestBed.tick();
    await settle();
    TestBed.tick();
    // Loading page 1: the pager stays, busy, and focus stays on Previous.
    expect(q('[data-testid="previous"]')).toBe(previous);
    expect(disabled('previous')).toBe(true);
    expect(document.activeElement).toBe(previous);
    previous.click(); // ignored while loading
    const first = await flushList(fixture, LIST, 'bob');
    expect(first.request.params.has('cursor')).toBe(false);
    expect(document.activeElement).toBe(previous);
    expect(q('[data-testid="page"]')?.textContent).toContain('Page 1');
    cleanup(fixture);
  });

  it('shows a load error with a retry', async () => {
    const fixture = TestBed.createComponent(AdminUsers);
    TestBed.tick();
    listRequest().flush(null, { status: 500, statusText: 'x' });
    await settle();
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(
      el.querySelector('[data-testid="users-error"]')?.textContent,
    ).toContain('Couldn’t load the users.');
    el.querySelector<HTMLElement>(
      '[data-testid="users-error"] button',
    )?.click();
    TestBed.tick();
    await flushList(fixture, LIST);
    expect(el.querySelector('[data-testid="users-table"]')).not.toBeNull();
  });

  it('bans after confirmation and updates the row', async () => {
    const { fixture, row, q } = await render();
    const title = await confirm(
      fixture,
      row('ada')?.querySelector<HTMLElement>('[data-testid="ban"]'),
      'confirm-ban',
    );
    expect(title).toContain('Ban ada@example.com?');
    const req = http.expectOne(`${USERS}/ada/ban`);
    expect(req.request.method).toBe('POST');
    req.flush(user('ada', { status: 'banned', plan: 'pro' }));
    await settle();
    await fixture.whenStable();

    expect(
      row('ada')?.querySelector('[data-testid="status"]')?.textContent,
    ).toContain('Banned');
    expect(q('[data-testid="announcement"]')?.textContent).toContain(
      'ada@example.com is banned.',
    );
    expect(document.activeElement).toBe(
      row('ada')?.querySelector('[data-testid="unban"]'),
    );
    cleanup(fixture);
  });

  it('sends one request for repeated confirms, and locks the dialog while it runs', async () => {
    const { fixture, row } = await render();
    row('ada')?.querySelector<HTMLElement>('[data-testid="ban"]')?.click();
    await fixture.whenStable();
    const action = document.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-ban"]',
    );
    const cancel = document.querySelector<HTMLButtonElement>(
      '[hlmAlertDialogCancel]',
    );
    action?.click();
    action?.click();
    await settle();
    await fixture.whenStable();
    const req = http.expectOne(`${USERS}/ada/ban`);
    expect(action?.disabled).toBe(true);
    expect(action?.textContent).toContain('Working…');
    expect(cancel?.disabled).toBe(true);

    // Cancel after Confirm can't close it mid-request (it isn't a real cancel).
    cancel?.click();
    await fixture.whenStable();
    expect(
      document.querySelector('[data-testid="confirm-ban"]'),
    ).not.toBeNull();

    req.flush(user('ada', { status: 'banned' }));
    await settle();
    await fixture.whenStable();
    expect(document.querySelector('[data-testid="confirm-ban"]')).toBeNull();
    expect(
      row('ada')?.querySelector('[data-testid="status"]')?.textContent,
    ).toContain('Banned');
    cleanup(fixture);
  });

  it('disables other confirmations while an action runs', async () => {
    const { fixture, row } = await render();
    await confirm(
      fixture,
      row('ada')?.querySelector<HTMLElement>('[data-testid="ban"]'),
      'confirm-ban',
    );
    const req = http.expectOne(`${USERS}/ada/ban`);
    // Another row's dialog, opened while the ban runs.
    row('bob')?.querySelector<HTMLElement>('[data-testid="unban"]')?.click();
    await fixture.whenStable();
    const unban = document.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-unban"]',
    );
    expect(unban?.disabled).toBe(true);
    expect(unban?.textContent).toContain('Unban');
    unban?.click();
    await settle();
    http.expectNone(`${USERS}/bob/unban`);
    req.flush(user('ada', { status: 'banned' }));
    await settle();
    await fixture.whenStable();
    cleanup(fixture);
  });

  it('does nothing when the ban is cancelled', async () => {
    const { fixture, row } = await render();
    const title = await confirm(
      fixture,
      row('ada')?.querySelector<HTMLElement>('[data-testid="ban"]'),
      'not-a-button',
    );
    expect(title).toContain('Ban ada@example.com?');
    document.querySelector<HTMLElement>('[hlmAlertDialogCancel]')?.click();
    await settle();
    http.expectNone(`${USERS}/ada/ban`);
    cleanup(fixture);
  });

  it('shows why a ban failed', async () => {
    const { fixture, row, q } = await render();
    await confirm(
      fixture,
      row('ada')?.querySelector<HTMLElement>('[data-testid="ban"]'),
      'confirm-ban',
    );
    http
      .expectOne(`${USERS}/ada/ban`)
      .flush(
        { code: 'admin_protected', message: 'Admins can’t be banned' },
        { status: 403, statusText: 'x' },
      );
    await settle();
    await fixture.whenStable();
    expect(q('[data-testid="notice"]')?.textContent).toContain(
      'Couldn’t ban ada@example.com: Admins can’t be banned',
    );
    expect(
      row('ada')?.querySelector('[data-testid="status"]')?.textContent,
    ).toContain('Active');
    q('[data-testid="notice"] button')?.click();
    await fixture.whenStable();
    expect(q('[data-testid="notice"]')).toBeNull();
    cleanup(fixture);
  });

  it('unbans after confirmation', async () => {
    const { fixture, row } = await render();
    const title = await confirm(
      fixture,
      row('bob')?.querySelector<HTMLElement>('[data-testid="unban"]'),
      'confirm-unban',
    );
    expect(title).toContain('Unban bob@example.com?');
    http.expectOne(`${USERS}/bob/unban`).flush(user('bob'));
    await settle();
    await fixture.whenStable();
    expect(
      row('bob')?.querySelector('[data-testid="status"]')?.textContent,
    ).toContain('Active');
    expect(document.activeElement).toBe(
      row('bob')?.querySelector('[data-testid="ban"]'),
    );
    cleanup(fixture);
  });

  it('impersonates after confirmation: signs in with the token, to the dashboard', async () => {
    const navigate = vi
      .spyOn(TestBed.inject(Router), 'navigateByUrl')
      .mockResolvedValue(true);
    const { fixture, row } = await render();
    const title = await confirm(
      fixture,
      row('ada')?.querySelector<HTMLElement>('[data-testid="impersonate"]'),
      'confirm-impersonate',
    );
    expect(title).toContain('View as ada@example.com?');
    const req = http.expectOne(`${USERS}/ada/impersonate`);
    expect(req.request.method).toBe('POST');
    req.flush({
      customToken: 'custom-token',
      expiresAt: '2026-11-27T12:30:00.000Z',
    });
    await settle();
    await settle();
    expect(auth.signInWithCustomToken).toHaveBeenCalledWith('custom-token');
    // The fake mirrors the real service: the new session is impersonated.
    expect(auth.impersonatedBy()).toBe('admin1');
    expect(auth.isAdmin()).toBe(false);
    expect(navigate).toHaveBeenCalledWith('/dashboard');
    cleanup(fixture);
  });

  it('shows why impersonation failed, staying signed in as the admin', async () => {
    const { fixture, row, q } = await render();
    await confirm(
      fixture,
      row('ada')?.querySelector<HTMLElement>('[data-testid="impersonate"]'),
      'confirm-impersonate',
    );
    http
      .expectOne(`${USERS}/ada/impersonate`)
      .flush(
        { message: 'Banned users cannot be impersonated' },
        { status: 409, statusText: 'x' },
      );
    await settle();
    await fixture.whenStable();
    expect(q('[data-testid="notice"]')?.textContent).toContain(
      'Couldn’t impersonate ada@example.com: Banned users cannot be impersonated',
    );
    expect(auth.signInWithCustomToken).not.toHaveBeenCalled();
    cleanup(fixture);
  });

  it('sends the admin to log in when the failed sign-in signed them out', async () => {
    auth.signInWithCustomToken.mockImplementationOnce(async () => {
      auth.setSignedOut();
      throw new Error('claims');
    });
    const navigate = vi
      .spyOn(TestBed.inject(Router), 'navigateByUrl')
      .mockResolvedValue(true);
    const { fixture, row, q } = await render();
    await confirm(
      fixture,
      row('ada')?.querySelector<HTMLElement>('[data-testid="impersonate"]'),
      'confirm-impersonate',
    );
    http
      .expectOne(`${USERS}/ada/impersonate`)
      .flush({ customToken: 't', expiresAt: '2026-11-27T12:30:00.000Z' });
    await settle();
    await settle();
    expect(navigate).toHaveBeenCalledWith(
      '/login?redirect=%2Fadmin&reason=impersonation-failed',
    );
    expect(q('[data-testid="notice"]')).toBeNull();
    cleanup(fixture);
  });

  it('goes on to the dashboard if the session switched despite the error', async () => {
    auth.signInWithCustomToken.mockImplementationOnce(async () => {
      auth.impersonatedBy.set('admin1');
      auth.signIn('ada');
      throw new Error('claims');
    });
    const navigate = vi
      .spyOn(TestBed.inject(Router), 'navigateByUrl')
      .mockResolvedValue(true);
    const { fixture, row } = await render();
    await confirm(
      fixture,
      row('ada')?.querySelector<HTMLElement>('[data-testid="impersonate"]'),
      'confirm-impersonate',
    );
    http
      .expectOne(`${USERS}/ada/impersonate`)
      .flush({ customToken: 't', expiresAt: '2026-11-27T12:30:00.000Z' });
    await settle();
    await settle();
    expect(navigate).toHaveBeenCalledWith('/dashboard');
    cleanup(fixture);
  });

  it('reports a failed sign-in with the token', async () => {
    auth.signInWithCustomToken.mockRejectedValueOnce(new Error('expired'));
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
    const { fixture, row, q } = await render();
    await confirm(
      fixture,
      row('ada')?.querySelector<HTMLElement>('[data-testid="impersonate"]'),
      'confirm-impersonate',
    );
    http
      .expectOne(`${USERS}/ada/impersonate`)
      .flush({ customToken: 't', expiresAt: '2026-11-27T12:30:00.000Z' });
    await settle();
    await fixture.whenStable();
    expect(q('[data-testid="notice"]')?.textContent).toContain(
      'Couldn’t sign in as ada@example.com',
    );
    expect(navigate).not.toHaveBeenCalled();
    cleanup(fixture);
  });
});
