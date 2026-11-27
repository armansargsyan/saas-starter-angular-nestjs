import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { FakeAuth } from '../../testing/fake-auth';
import { settle } from '../../testing/settle';
import { AuthService } from '../core/auth.service';
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
        { provide: AuthService, useValue: auth },
      ],
    });
  });

  async function render() {
    const fixture = TestBed.createComponent(AppShell);
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
      el.querySelector('[data-testid="account-email"]')?.textContent,
    ).toContain('u1@example.com');
    expect(el.querySelector('main#main')).not.toBeNull();
  });

  it('shows Admin only to admins', async () => {
    auth.role.set('admin');
    const { el } = await render();
    expect(
      [...el.querySelectorAll('nav a')].map((a) => a.textContent?.trim()),
    ).toContain('Admin');
  });

  it('shows the impersonation banner and the verify banner when relevant', async () => {
    auth.impersonatedBy.set('admin-1');
    auth.signIn('u1', { emailVerified: false, providers: ['password'] });
    const { el } = await render();
    expect(
      el.querySelector('[data-testid="impersonation-banner"]'),
    ).not.toBeNull();
    expect(el.querySelector('[data-testid="verify-banner"]')).not.toBeNull();
  });

  it('signs out to the home page', async () => {
    const navigate = vi
      .spyOn(TestBed.inject(Router), 'navigateByUrl')
      .mockResolvedValue(true);
    const { el } = await render();
    [...el.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Sign out'))
      ?.click();
    await settle();
    expect(auth.signOut).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/');
  });
});
