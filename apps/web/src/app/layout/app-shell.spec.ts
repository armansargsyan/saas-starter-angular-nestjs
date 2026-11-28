import { OVERLAY_DEFAULT_CONFIG } from '@angular/cdk/overlay';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import type { Team } from '@saas-starter/shared';
import { provideRouter, Router } from '@angular/router';
import { FakeAuth } from '../../testing/fake-auth';
import { settle } from '../../testing/settle';
import { AuthService } from '../core/auth.service';
import { WorkspaceService } from '../core/workspace.service';
import { AppShell } from './app-shell';

describe('AppShell', () => {
  let auth: FakeAuth;

  beforeEach(() => {
    auth = new FakeAuth();
    auth.signIn('u1', { emailVerified: true });
    TestBed.configureTestingModule({
      imports: [AppShell],
      providers: [
        provideRouter([{ path: '**', children: [] }]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: auth },
        // As SIGNED_IN_ROUTES provides it (the account menu is an overlay).
        { provide: OVERLAY_DEFAULT_CONFIG, useValue: { usePopover: false } },
      ],
    });
    window.localStorage.clear();
  });

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  let teams: Team[] = [];
  beforeEach(() => (teams = []));

  async function render() {
    const fixture = TestBed.createComponent(AppShell);
    TestBed.tick();
    TestBed.inject(HttpTestingController)
      .expectOne('/api/teams')
      .flush({ items: teams });
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('has app navigation, the account and a main landmark', async () => {
    const { el } = await render();
    const links = [...el.querySelectorAll('nav a')].map((a) =>
      a.textContent?.trim(),
    );
    expect(links).toEqual(['Links', 'Teams', 'Billing']);
    expect(
      el.querySelector('[data-testid="account-name"]')?.textContent,
    ).toContain('u1@example.com');
    expect(
      el
        .querySelector('[data-testid="account-menu"]')
        ?.getAttribute('aria-label'),
    ).toBe('Account menu, u1@example.com');
    expect(el.querySelector('main#main')).not.toBeNull();
  });

  it('shows Admin only to admins', async () => {
    auth.role.set('admin');
    const { el } = await render();
    expect(
      [...el.querySelectorAll('nav a')].map((a) => a.textContent?.trim()),
    ).toContain('Admin');
  });

  it('shows the verify banner to unverified password accounts', async () => {
    auth.signIn('u1', { emailVerified: false, providers: ['password'] });
    const { el } = await render();
    expect(el.querySelector('[data-testid="verify-banner"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="impersonation-banner"]')).toBeNull();
  });

  it('shows no verify banner until the claims are known (fail closed)', async () => {
    auth.signIn('u1', { emailVerified: false, providers: ['password'] });
    auth.claimsRead.set(false);
    const { el, fixture } = await render();
    expect(el.querySelector('[data-testid="verify-banner"]')).toBeNull();
    auth.claimsRead.set(true);
    await fixture.whenStable();
    expect(el.querySelector('[data-testid="verify-banner"]')).not.toBeNull();
  });

  it('while impersonating: the impersonation banner, never the verify banner', async () => {
    auth.impersonatedBy.set('admin-1');
    auth.signIn('u1', { emailVerified: false, providers: ['password'] });
    const { el } = await render();
    expect(
      el.querySelector('[data-testid="impersonation-banner"]'),
    ).not.toBeNull();
    // Its link leads out of the shell, where Resend would email the user.
    expect(el.querySelector('[data-testid="verify-banner"]')).toBeNull();
  });

  it('names the impersonated account and when the session ends', async () => {
    auth.impersonatedBy.set('admin-1');
    auth.impersonationStartedAt.set(Date.now() - 20 * 60_000);
    const { el } = await render();
    const banner = el.querySelector('[data-testid="impersonation-banner"]');
    expect(banner?.textContent).toContain('u1@example.com');
    expect(banner?.textContent).toContain('read-only, until');
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('stops impersonating by signing out, back to the admin login', async () => {
    auth.impersonatedBy.set('admin-1');
    const navigate = vi
      .spyOn(TestBed.inject(Router), 'navigateByUrl')
      .mockResolvedValue(true);
    const { el } = await render();
    el.querySelector<HTMLElement>(
      '[data-testid="stop-impersonating"]',
    )?.click();
    await settle();
    expect(auth.signOut).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/login?redirect=%2Fadmin');
  });

  it('says so when signing out fails, and stays', async () => {
    auth.impersonatedBy.set('admin-1');
    auth.signOut.mockRejectedValueOnce(new Error('offline'));
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
    const { el, fixture } = await render();
    el.querySelector<HTMLElement>(
      '[data-testid="stop-impersonating"]',
    )?.click();
    await settle();
    await fixture.whenStable();
    expect(
      el.querySelector('[data-testid="stop-failed"]')?.textContent,
    ).toContain('Couldn’t sign out');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('ends an already-expired impersonated session on arrival, with a reason', async () => {
    auth.impersonatedBy.set('admin-1');
    auth.impersonationStartedAt.set(Date.now() - 31 * 60_000);
    const navigate = vi
      .spyOn(TestBed.inject(Router), 'navigateByUrl')
      .mockResolvedValue(true);
    await render();
    await settle();
    await settle();
    expect(auth.signOut).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(
      '/login?redirect=%2Fadmin&reason=impersonation-ended',
    );
  });

  describe('the impersonation timer', () => {
    afterEach(() => vi.useRealTimers());

    it('signs out exactly when the window ends, not before', async () => {
      const navigate = vi
        .spyOn(TestBed.inject(Router), 'navigateByUrl')
        .mockResolvedValue(true);
      const { fixture } = await render();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      // 29 minutes into the 30-minute window.
      auth.impersonatedBy.set('admin-1');
      auth.impersonationStartedAt.set(Date.now() - 29 * 60_000);
      TestBed.tick();
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(60_000 - 1);
      expect(auth.signOut).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(auth.signOut).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith(
        '/login?redirect=%2Fadmin&reason=impersonation-ended',
      );
      fixture.destroy();
    });

    it('clears the timer when impersonation ends first', async () => {
      const { fixture } = await render();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      auth.impersonatedBy.set('admin-1');
      auth.impersonationStartedAt.set(Date.now() - 29 * 60_000);
      TestBed.tick();
      expect(vi.getTimerCount()).toBe(1);

      auth.impersonatedBy.set(null);
      TestBed.tick();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(auth.signOut).not.toHaveBeenCalled();
      fixture.destroy();
    });
  });

  it('signs out to the home page', async () => {
    const navigate = vi
      .spyOn(TestBed.inject(Router), 'navigateByUrl')
      .mockResolvedValue(true);
    const { fixture, el } = await render();
    el.querySelector<HTMLElement>('[data-testid="account-menu"]')?.click();
    await fixture.whenStable();
    // The menu renders in an overlay, outside the component.
    document
      .querySelector<HTMLElement>('[data-testid="menu-sign-out"]')
      ?.click();
    await settle();
    expect(auth.signOut).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('hides the workspace switcher until you are in a team', async () => {
    const { el } = await render();
    expect(el.querySelector('[data-testid="workspace-switcher"]')).toBeNull();
  });

  it('switches between the personal workspace and teams', async () => {
    teams = [
      {
        id: 't1',
        name: 'Acme',
        role: 'admin',
        plan: 'team',
        memberCount: 3,
        createdAt: '2026-11-01T00:00:00.000Z',
      },
    ];
    const { fixture, el } = await render();
    const select = el.querySelector('#workspace-switcher') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual([
      'Personal',
      'Acme',
    ]);
    expect(
      el.querySelector('label[for="workspace-switcher"]')?.textContent,
    ).toBe('Workspace');
    select.value = 't1';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(TestBed.inject(WorkspaceService).workspaceId()).toBe('t1');
  });
});
