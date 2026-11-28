import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import {
  provideRouter,
  Router,
  withComponentInputBinding,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { FakeAuth } from '../../../testing/fake-auth';
import { settle } from '../../../testing/settle';
import { AuthService } from '../../core/auth.service';
import { BillingService } from '../../core/billing.service';
import { LoginPage } from './login-page';
import { ResetPasswordPage } from './reset-password-page';
import { SignupPage } from './signup-page';
import { VerifyEmailPage } from './verify-email-page';

/** Stands in for the real dashboard (its data loading is tested elsewhere). */
@Component({ template: 'dashboard' })
class DashboardStub {}

describe('auth pages', () => {
  let auth: FakeAuth;
  let billing: { startCheckout: ReturnType<typeof vi.fn> };
  let harness: RouterTestingHarness;
  let router: Router;

  beforeEach(async () => {
    auth = new FakeAuth();
    billing = { startCheckout: vi.fn().mockResolvedValue({ ok: true }) };
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            { path: 'login', component: LoginPage },
            { path: 'signup', component: SignupPage },
            { path: 'reset-password', component: ResetPasswordPage },
            { path: 'verify-email', component: VerifyEmailPage },
            { path: 'dashboard', component: DashboardStub },
            { path: 'teams', children: [] },
            { path: 'admin', children: [] },
            { path: 'invite', children: [] },
            { path: 'links/:code', children: [] },
            { path: '', children: [] },
          ],
          // Query params → component inputs, as in the app config.
          withComponentInputBinding(),
        ),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: auth },
        { provide: BillingService, useValue: billing },
      ],
    });
    harness = await RouterTestingHarness.create();
    router = TestBed.inject(Router);
  });

  const el = () => harness.routeNativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
    el().querySelector<T>(selector);
  const type = (id: string, value: string) => {
    const input = q<HTMLInputElement>(`#${id}`);
    if (!input) throw new Error(`no #${id}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
  };
  const submit = async () => {
    q('form')?.dispatchEvent(new Event('submit'));
    await settle();
    await harness.fixture.whenStable();
  };
  const click = async (testid: string) => {
    q(`[data-testid="${testid}"]`)?.click();
    await settle();
    await harness.fixture.whenStable();
  };

  describe('login', () => {
    it('shows field errors, and focuses the first one, instead of submitting', async () => {
      await harness.navigateByUrl('/login');
      await submit();
      await harness.fixture.whenStable();

      expect(auth.signInWithEmail).not.toHaveBeenCalled();
      expect(q('#email-error')?.textContent).toContain('Enter your email');
      expect(q('#password-error')?.textContent).toContain(
        'Enter your password',
      );
      expect(q('#email')?.getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement?.id).toBe('email');
    });

    it('signs in and follows a safe redirect, never an external one', async () => {
      await harness.navigateByUrl('/login?redirect=%2Flinks%2Fabc');
      type('email', ' ada@example.com ');
      type('password', 'secret-pass');
      await submit();
      expect(auth.signInWithEmail).toHaveBeenCalledWith(
        'ada@example.com',
        'secret-pass',
      );
      expect(router.url).toBe('/links/abc');

      auth.setSignedOut();
      await harness.navigateByUrl('/login?redirect=%2F%2Fevil.test');
      type('email', 'ada@example.com');
      type('password', 'secret-pass');
      await submit();
      expect(router.url).toBe('/dashboard');
    });

    it('explains an ended impersonation session, and only then', async () => {
      await harness.navigateByUrl('/login?redirect=%2Fadmin');
      expect(q('[data-testid="signed-out-reason"]')).toBeNull();
      await harness.navigateByUrl(
        '/login?redirect=%2Fadmin&reason=impersonation-ended',
      );
      expect(q('[data-testid="signed-out-reason"]')?.textContent).toContain(
        'Impersonation ended',
      );
      type('email', 'admin@example.com');
      type('password', 'secret-pass');
      await submit();
      expect(router.url).toBe('/admin');

      auth.setSignedOut();
      await harness.navigateByUrl(
        '/login?redirect=%2Fadmin&reason=impersonation-failed',
      );
      expect(q('[data-testid="signed-out-reason"]')?.textContent).toContain(
        'Couldn’t view as that user',
      );
    });

    it('keeps the redirect on the "Create an account" link', async () => {
      await harness.navigateByUrl('/login?redirect=%2Flinks%2Fabc');
      expect(q('a[href^="/signup"]')?.getAttribute('href')).toBe(
        '/signup?redirect=%2Flinks%2Fabc',
      );
    });

    it('shows a friendly error and stays put', async () => {
      auth.signInWithEmail.mockRejectedValueOnce({
        code: 'auth/invalid-credential',
      });
      await harness.navigateByUrl('/login');
      type('email', 'ada@example.com');
      type('password', 'wrong');
      await submit();

      expect(q('[data-testid="auth-error"]')?.textContent).toContain(
        'don’t match',
      );
      expect(router.url).toBe('/login');
      expect(q('[data-testid="submit"]')?.textContent).toContain('Sign in');
    });

    it('marks Google unavailable while an email sign-in is running', async () => {
      let finish: () => void = () => undefined;
      auth.signInWithEmail.mockImplementationOnce(
        () => new Promise<void>((resolve) => (finish = resolve)),
      );
      await harness.navigateByUrl('/login');
      type('email', 'ada@example.com');
      type('password', 'pw');
      await submit();

      expect(q('[data-testid="google"]')?.getAttribute('aria-disabled')).toBe(
        'true',
      );
      await click('google');
      expect(auth.signInWithGoogle).not.toHaveBeenCalled();
      finish();
      await settle();
    });

    it('signs in with Google; closing the popup is not an error', async () => {
      auth.signInWithGoogle.mockRejectedValueOnce({
        code: 'auth/popup-closed-by-user',
      });
      await harness.navigateByUrl('/login');
      await click('google');
      expect(q('[data-testid="auth-error"]')).toBeNull();

      await click('google');
      expect(router.url).toBe('/dashboard');
    });
  });

  describe('signup', () => {
    it('requires a password of 8+ characters', async () => {
      await harness.navigateByUrl('/signup');
      type('email', 'ada@example.com');
      type('password', 'short');
      await submit();

      expect(auth.signUpWithEmail).not.toHaveBeenCalled();
      expect(q('#password-error')?.textContent).toContain(
        'at least 8 characters',
      );
    });

    it('reports a name that is too long', async () => {
      await harness.navigateByUrl('/signup');
      type('name', 'x'.repeat(81));
      type('email', 'ada@example.com');
      type('password', 'long-enough');
      await submit();

      expect(auth.signUpWithEmail).not.toHaveBeenCalled();
      expect(q('#name-error')?.textContent).toContain('at most 80');
    });

    it('creates the account and asks to verify the email', async () => {
      await harness.navigateByUrl('/signup');
      type('name', ' Ada ');
      type('email', 'ada@example.com');
      type('password', 'long-enough');
      await submit();

      expect(auth.signUpWithEmail).toHaveBeenCalledWith(
        'ada@example.com',
        'long-enough',
        'Ada',
      );
      expect(router.url).toBe('/verify-email?sent=1');
    });

    it('goes straight to Checkout after choosing Pro', async () => {
      await harness.navigateByUrl('/signup?plan=pro');
      expect(q('[data-testid="chosen-plan"]')?.textContent).toContain('Pro');
      type('email', 'ada@example.com');
      type('password', 'long-enough');
      await submit();

      expect(billing.startCheckout).toHaveBeenCalledWith({
        workspaceId: 'u1',
        plan: 'pro',
      });
    });

    it('says so when Checkout can’t start after creating the account', async () => {
      billing.startCheckout.mockResolvedValueOnce({
        ok: false,
        code: 'unknown',
      });
      await harness.navigateByUrl('/signup?plan=pro');
      type('email', 'ada@example.com');
      type('password', 'long-enough');
      await submit();

      expect(q('[data-testid="checkout-failed"]')?.textContent).toContain(
        'checkout couldn’t start',
      );
      expect(router.url).toBe('/signup?plan=pro');
      expect(q('form')).toBeNull(); // no second sign-up attempt
    });

    it('goes to creating a team after choosing Team, and on via Google', async () => {
      await harness.navigateByUrl('/signup?plan=team');
      type('email', 'ada@example.com');
      type('password', 'long-enough');
      await submit();
      expect(router.url).toBe('/teams?new=1');

      auth.setSignedOut();
      await harness.navigateByUrl('/signup?redirect=%2Flinks%2Fabc');
      await click('google');
      expect(router.url).toBe('/links/abc');
    });

    it('explains an email that already has an account', async () => {
      auth.signUpWithEmail.mockRejectedValueOnce({
        code: 'auth/email-already-in-use',
      });
      await harness.navigateByUrl('/signup');
      type('email', 'ada@example.com');
      type('password', 'long-enough');
      await submit();
      expect(q('[data-testid="auth-error"]')?.textContent).toContain(
        'already exists',
      );
    });
  });

  describe('reset password', () => {
    it('confirms without revealing whether the account exists, and moves focus there', async () => {
      await harness.navigateByUrl('/reset-password');
      type('email', 'ada@example.com');
      await submit();
      await harness.fixture.whenStable();

      expect(auth.sendPasswordReset).toHaveBeenCalledWith('ada@example.com');
      expect(q('[role="status"] [data-testid="sent"]')?.textContent).toContain(
        'If an account exists',
      );
      expect(document.activeElement?.id).toBe('reset-sent');
    });
  });

  describe('verify email', () => {
    beforeEach(() =>
      auth.signIn('u1', { emailVerified: false, providers: ['password'] }),
    );

    it('sends an impersonated session to the dashboard without touching the account', async () => {
      auth.impersonatedBy.set('admin-1');
      await harness.navigateByUrl('/verify-email');
      await settle();
      expect(router.url).toBe('/dashboard');
      expect(auth.reloadUser).not.toHaveBeenCalled();
      expect(auth.resendVerification).not.toHaveBeenCalled();
    });

    it('leaves once the claims show the session is impersonated', async () => {
      await harness.navigateByUrl('/verify-email');
      expect(router.url).toBe('/verify-email');
      auth.impersonatedBy.set('admin-1');
      await settle();
      await harness.fixture.whenStable();
      expect(router.url).toBe('/dashboard');
    });

    it('re-checks on arrival and moves on if already verified (the emailed link)', async () => {
      auth.reloadUser.mockImplementationOnce(async () => {
        auth.signIn('u1', { emailVerified: true, providers: ['password'] });
        return auth.user() ?? null;
      });
      await harness.navigateByUrl('/verify-email');
      await settle();
      expect(router.url).toBe('/dashboard');
    });

    it('says when the email isn’t verified yet, and moves on once it is', async () => {
      await harness.navigateByUrl('/verify-email');
      await click('check');
      expect(q('[data-testid="status"]')?.textContent).toContain(
        'Not verified yet',
      );

      auth.reloadUser.mockImplementationOnce(async () => {
        auth.signIn('u1', { emailVerified: true, providers: ['password'] });
        return auth.user() ?? null;
      });
      await click('check');
      expect(router.url).toBe('/dashboard');
    });

    it('goes back to a pending invite once verified', async () => {
      window.sessionStorage.setItem('saas-starter.invite-token', 'tok');
      auth.reloadUser.mockImplementationOnce(async () => {
        auth.signIn('u1', { emailVerified: true, providers: ['password'] });
        return auth.user() ?? null;
      });
      await harness.navigateByUrl('/verify-email');
      expect(q('[data-testid="invite-hint"]')?.textContent).toContain(
        'come back here',
      );
      await settle();
      expect(router.url).toBe('/invite');
      window.sessionStorage.clear();
    });

    it('lets a later visit resend right away, once per click burst', async () => {
      await harness.navigateByUrl('/verify-email');
      await settle();
      await harness.fixture.whenStable();
      expect(q('[data-testid="resend"]')?.textContent).toContain(
        'Resend the email',
      );

      q('[data-testid="resend"]')?.click();
      q('[data-testid="resend"]')?.click(); // double click: sent once
      await settle();
      expect(auth.resendVerification).toHaveBeenCalledTimes(1);
    });

    it('right after sign-up, rate limits resending with a visible countdown', async () => {
      vi.useFakeTimers();
      try {
        await harness.navigateByUrl('/verify-email?sent=1');
        expect(q('[data-testid="resend"]')?.textContent).toContain(
          'Resend in 30s',
        );
        q('[data-testid="resend"]')?.click();
        expect(auth.resendVerification).not.toHaveBeenCalled();

        vi.advanceTimersByTime(30_000);
        harness.detectChanges();
        q('[data-testid="resend"]')?.click();
        await vi.runOnlyPendingTimersAsync();
        expect(auth.resendVerification).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
