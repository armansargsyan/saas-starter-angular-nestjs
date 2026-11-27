import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { OVERLAY_DEFAULT_CONFIG } from '@angular/cdk/overlay';
import { provideRouter, Router } from '@angular/router';
import { FakeAuth } from '../../../testing/fake-auth';
import { settle } from '../../../testing/settle';
import { AuthService } from '../../core/auth.service';
import { ThemeService } from '../../core/theme.service';
import { SettingsPage } from './settings-page';

describe('SettingsPage', () => {
  let auth: FakeAuth;
  let http: HttpTestingController;

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
    auth = new FakeAuth();
    auth.signIn('u1', { displayName: 'Ada' });
    TestBed.configureTestingModule({
      imports: [SettingsPage],
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

  async function render() {
    const fixture = TestBed.createComponent(SettingsPage);
    // Attached, so focus moves can be checked.
    document.body.appendChild(fixture.nativeElement);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const q = <T extends HTMLElement = HTMLElement>(s: string) =>
      el.querySelector<T>(s);
    return { fixture, el, q };
  }

  const type = (el: HTMLElement | null, value: string) => {
    (el as HTMLInputElement).value = value;
    el?.dispatchEvent(new Event('input'));
  };

  describe('profile', () => {
    it('saves the name and picture, and the shell sees it', async () => {
      const { fixture, q } = await render();
      expect(q<HTMLInputElement>('#settings-name')?.value).toBe('Ada');
      expect(q('[data-testid="avatar-initials"]')?.textContent?.trim()).toBe(
        'A',
      );

      type(q('#settings-name'), '  Ada Lovelace ');
      type(q('#settings-photo'), 'https://example.com/ada.png');
      await fixture.whenStable();
      // The preview follows what's typed.
      expect(q('[data-testid="avatar-initials"]')?.textContent?.trim()).toBe(
        'AL',
      );
      expect(q('[data-testid="avatar-image"]')?.getAttribute('src')).toBe(
        'https://example.com/ada.png',
      );

      q('[data-testid="save-profile"]')?.click();
      const req = http.expectOne('/api/account/profile');
      expect(req.request.method).toBe('PATCH');
      expect(req.request.body).toEqual({
        displayName: '  Ada Lovelace ',
        photoURL: 'https://example.com/ada.png',
      });
      req.flush({
        displayName: 'Ada Lovelace',
        photoURL: 'https://example.com/ada.png',
      });
      await settle();
      await fixture.whenStable();

      expect(auth.refreshProfile).toHaveBeenCalledWith({
        displayName: 'Ada Lovelace',
        photoURL: 'https://example.com/ada.png',
      });
      expect(auth.user()?.displayName).toBe('Ada Lovelace');
      expect(q<HTMLInputElement>('#settings-name')?.value).toBe('Ada Lovelace');
      expect(q('[data-testid="profile-status"]')?.textContent).toContain(
        'Profile saved.',
      );
      fixture.nativeElement.remove();
    });

    it('checks the picture URL before sending, and focuses the field', async () => {
      const { fixture, q } = await render();
      type(q('#settings-photo'), 'http://example.com/a.png');
      q('[data-testid="save-profile"]')?.click();
      await fixture.whenStable();

      http.expectNone('/api/account/profile');
      expect(q('#settings-photo-error')?.textContent).toContain(
        'The picture URL must be an https:// URL.',
      );
      expect(q('#settings-photo')?.getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement?.id).toBe('settings-photo');
      fixture.nativeElement.remove();
    });

    it('shows server field errors on the field, and other errors below', async () => {
      const { fixture, q } = await render();
      type(q('#settings-name'), 'Grace');
      q('[data-testid="save-profile"]')?.click();
      http.expectOne('/api/account/profile').flush(
        {
          statusCode: 400,
          message: 'Validation failed',
          issues: [{ path: 'displayName', message: 'is not allowed' }],
        },
        { status: 400, statusText: 'Bad Request' },
      );
      await settle();
      await fixture.whenStable();
      expect(q('#settings-name-error')?.textContent).toContain(
        'Is not allowed',
      );

      type(q('#settings-name'), 'Grace H');
      q('[data-testid="save-profile"]')?.click();
      http
        .expectOne('/api/account/profile')
        .flush(null, { status: 503, statusText: 'Unavailable' });
      await settle();
      await fixture.whenStable();
      expect(q('[data-testid="profile-error"]')?.textContent).toContain(
        'Something went wrong',
      );
      expect(auth.refreshProfile).not.toHaveBeenCalled();
      fixture.nativeElement.remove();
    });

    it('takes in a profile change from elsewhere, but keeps unsaved edits', async () => {
      const { fixture, q } = await render();
      auth.state.update((u) => (u ? { ...u, displayName: 'Ada L.' } : u));
      await fixture.whenStable();
      expect(q<HTMLInputElement>('#settings-name')?.value).toBe('Ada L.');

      type(q('#settings-photo'), 'https://example.com/mine.png');
      auth.state.update((u) =>
        u ? { ...u, displayName: 'Ada B.', photoURL: 'https://x/y.png' } : u,
      );
      await fixture.whenStable();
      expect(q<HTMLInputElement>('#settings-name')?.value).toBe('Ada B.');
      expect(q<HTMLInputElement>('#settings-photo')?.value).toBe(
        'https://example.com/mine.png',
      );
      fixture.nativeElement.remove();
    });

    it('does nothing until something changed', async () => {
      const { fixture, q } = await render();
      const save = q('[data-testid="save-profile"]');
      expect(save?.getAttribute('aria-disabled')).toBe('true');
      save?.click();
      await fixture.whenStable();
      http.expectNone('/api/account/profile');
      fixture.nativeElement.remove();
    });
  });

  describe('appearance', () => {
    it('switches and remembers the theme', async () => {
      const { fixture, q } = await render();
      expect(q<HTMLInputElement>('[data-testid="theme-system"]')?.checked).toBe(
        true,
      );
      q('[data-testid="theme-dark"]')?.click();
      await fixture.whenStable();
      expect(TestBed.inject(ThemeService).preference()).toBe('dark');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(q<HTMLInputElement>('[data-testid="theme-dark"]')?.checked).toBe(
        true,
      );
      q('[data-testid="theme-light"]')?.click();
      await fixture.whenStable();
      expect(document.documentElement.classList.contains('dark')).toBe(false);
      fixture.nativeElement.remove();
    });
  });

  describe('delete account', () => {
    async function openDialog() {
      const r = await render();
      r.q('[data-testid="delete-account"]')?.click();
      await r.fixture.whenStable();
      const d = <T extends HTMLElement = HTMLElement>(s: string) =>
        document.querySelector<T>(`.cdk-overlay-container ${s}`);
      return { ...r, d };
    }

    it('needs the email typed before it deletes', async () => {
      const { fixture, d } = await openDialog();
      expect(d('h2')?.textContent).toContain('Delete your account?');
      expect(d('label[for="delete-confirm"]')?.textContent).toContain(
        'Type u1@example.com to confirm',
      );
      expect(
        d('[data-testid="confirm-delete"]')?.getAttribute('aria-disabled'),
      ).toBe('true');

      type(d('#delete-confirm'), 'someone@example.com');
      d('[data-testid="confirm-delete"]')?.click();
      await fixture.whenStable();
      http.expectNone('/api/account');
      expect(d('#delete-confirm-error')?.textContent).toContain(
        'Type u1@example.com to confirm.',
      );
      fixture.nativeElement.remove();
    });

    it('deletes, signs out and goes home with a confirmation', async () => {
      const navigate = vi
        .spyOn(TestBed.inject(Router), 'navigateByUrl')
        .mockResolvedValue(true);
      const { fixture, d } = await openDialog();

      // Case and surrounding spaces don't matter.
      type(d('#delete-confirm'), ' U1@Example.com ');
      await fixture.whenStable();
      expect(
        d('[data-testid="confirm-delete"]')?.getAttribute('aria-disabled'),
      ).toBeNull();
      d('[data-testid="confirm-delete"]')?.click();
      const req = http.expectOne('/api/account');
      expect(req.request.method).toBe('DELETE');
      req.flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      await settle();

      expect(auth.signOut).toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith('/', {
        state: { accountDeleted: true },
      });
      fixture.nativeElement.remove();
    });

    it('explains which teams block it, and keeps the session', async () => {
      const { fixture, d } = await openDialog();
      type(d('#delete-confirm'), 'u1@example.com');
      d('[data-testid="confirm-delete"]')?.click();
      http.expectOne('/api/account').flush(
        {
          statusCode: 409,
          code: 'owns_team_with_members',
          message:
            'You own a team with other members (Acme). Remove the other members first, then delete your account.',
          teams: [{ id: 't1', name: 'Acme' }],
        },
        { status: 409, statusText: 'Conflict' },
      );
      await settle();
      await fixture.whenStable();

      expect(d('[data-testid="delete-error"]')?.textContent).toContain(
        'Remove the other members first',
      );
      expect(d('[data-testid="delete-error"] a')?.getAttribute('href')).toBe(
        '/teams/t1',
      );
      expect(auth.signOut).not.toHaveBeenCalled();
      fixture.nativeElement.remove();
    });

    const RECENT_LOGIN = {
      statusCode: 403,
      code: 'requires_recent_login',
      message: 'Sign in again to delete your account.',
    };

    async function confirmAndSubmit(d: (s: string) => HTMLElement | null) {
      type(d('#delete-confirm'), 'u1@example.com');
      d('[data-testid="confirm-delete"]')?.click();
      await settle();
    }

    it('asks a password account for its password, then deletes', async () => {
      auth.signIn('u1', { providers: ['password'] });
      const navigate = vi
        .spyOn(TestBed.inject(Router), 'navigateByUrl')
        .mockResolvedValue(true);
      const { fixture, d } = await openDialog();
      await confirmAndSubmit(d);
      http
        .expectOne('/api/account')
        .flush(RECENT_LOGIN, { status: 403, statusText: 'Forbidden' });
      await settle();
      await fixture.whenStable();

      expect(d('[data-testid="delete-error"]')?.textContent).toContain(
        'enter your password',
      );
      expect(document.activeElement?.id).toBe('delete-password');

      // Empty: asks again, sends nothing.
      d('[data-testid="confirm-delete"]')?.click();
      await settle();
      expect(auth.reauthenticateWithPassword).not.toHaveBeenCalled();

      type(d('#delete-password'), 'my-password');
      d('[data-testid="confirm-delete"]')?.click();
      await settle();
      expect(auth.reauthenticateWithPassword).toHaveBeenCalledWith(
        'my-password',
      );
      http
        .expectOne('/api/account')
        .flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      await settle();
      expect(navigate).toHaveBeenCalledWith('/', {
        state: { accountDeleted: true },
      });
      fixture.nativeElement.remove();
    });

    it('shows a wrong password and sends nothing', async () => {
      auth.signIn('u1', { providers: ['password'] });
      auth.reauthenticateWithPassword.mockRejectedValueOnce({
        code: 'auth/invalid-credential',
      });
      const { fixture, d } = await openDialog();
      await confirmAndSubmit(d);
      http
        .expectOne('/api/account')
        .flush(RECENT_LOGIN, { status: 403, statusText: 'Forbidden' });
      await settle();
      await fixture.whenStable();
      type(d('#delete-password'), 'wrong');
      d('[data-testid="confirm-delete"]')?.click();
      await settle();
      await fixture.whenStable();

      http.expectNone('/api/account');
      expect(d('[data-testid="delete-error"]')?.textContent).toContain(
        'don’t match',
      );
      expect(auth.signOut).not.toHaveBeenCalled();
      fixture.nativeElement.remove();
    });

    it('lets a Google account confirm in a popup, then deletes', async () => {
      const navigate = vi
        .spyOn(TestBed.inject(Router), 'navigateByUrl')
        .mockResolvedValue(true);
      const { fixture, d } = await openDialog();
      await confirmAndSubmit(d);
      http
        .expectOne('/api/account')
        .flush(RECENT_LOGIN, { status: 403, statusText: 'Forbidden' });
      await settle();
      await fixture.whenStable();

      expect(d('#delete-password')).toBeNull();
      d('[data-testid="confirm-delete-google"]')?.click();
      // Called right in the click handler (the popup needs the gesture).
      expect(auth.reauthenticateWithGoogle).toHaveBeenCalledTimes(1);
      await settle();
      http
        .expectOne('/api/account')
        .flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      await settle();
      expect(navigate).toHaveBeenCalledWith('/', {
        state: { accountDeleted: true },
      });
      fixture.nativeElement.remove();
    });

    it('in Google mode, Enter in the field confirms with Google too', async () => {
      const { fixture, d } = await openDialog();
      await confirmAndSubmit(d);
      http.expectOne('/api/account').flush(
        {
          statusCode: 403,
          code: 'requires_recent_login',
          message: 'Sign in again to delete your account.',
        },
        { status: 403, statusText: 'Forbidden' },
      );
      await settle();
      await fixture.whenStable();

      d('#delete-confirm')
        ?.closest('form')
        ?.dispatchEvent(new Event('submit', { cancelable: true }));
      expect(auth.reauthenticateWithGoogle).toHaveBeenCalledTimes(1);
      await settle();
      http
        .expectOne('/api/account')
        .flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      fixture.nativeElement.remove();
    });

    it.each([
      ['a 401, and Firebase says the user is gone', 401, true],
      ['a lost answer, and Firebase says the user is gone', 504, true],
      ['a network error, and Firebase says the user is gone', 0, true],
    ])('treats %s as deleted', async (_, status, gone) => {
      auth.accountGone = gone;
      const navigate = vi
        .spyOn(TestBed.inject(Router), 'navigateByUrl')
        .mockResolvedValue(true);
      const { fixture, d } = await openDialog();
      await confirmAndSubmit(d);
      const req = http.expectOne('/api/account');
      if (status === 0) req.error(new ProgressEvent('error'));
      else req.flush(null, { status, statusText: 'x' });
      await settle();
      await settle();
      expect(auth.signOut).toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith('/', {
        state: { accountDeleted: true },
      });
      fixture.nativeElement.remove();
    });

    it('does not take a 401 for a deletion while the account exists: asks to sign in again', async () => {
      auth.accountGone = false;
      const navigate = vi
        .spyOn(TestBed.inject(Router), 'navigate')
        .mockResolvedValue(true);
      const byUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
      const { fixture, d } = await openDialog();
      await confirmAndSubmit(d);
      http
        .expectOne('/api/account')
        .flush(
          { statusCode: 401, message: 'Missing bearer token' },
          { status: 401, statusText: 'Unauthorized' },
        );
      await settle();
      await fixture.whenStable();

      expect(auth.isAccountGone).toHaveBeenCalled();
      expect(d('[data-testid="delete-error"]')?.textContent).toContain(
        'Your session expired',
      );
      expect(auth.signOut).not.toHaveBeenCalled();
      expect(byUrl).not.toHaveBeenCalled();

      d('[data-testid="sign-in-again"]')?.click();
      await settle();
      expect(auth.signOut).toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith(['/login'], {
        queryParams: { redirect: '/settings' },
      });
      fixture.nativeElement.remove();
    });

    it('says to try again when the answer is lost and the account still exists', async () => {
      auth.accountGone = false;
      const { fixture, d } = await openDialog();
      await confirmAndSubmit(d);
      http
        .expectOne('/api/account')
        .flush(null, { status: 503, statusText: 'Unavailable' });
      await settle();
      await fixture.whenStable();
      expect(auth.isAccountGone).toHaveBeenCalled();
      expect(d('[data-testid="delete-error"]')?.textContent).toContain(
        'try again',
      );
      expect(auth.signOut).not.toHaveBeenCalled();
      fixture.nativeElement.remove();
    });
  });

  it('is read-only while impersonating', async () => {
    auth.impersonatedBy.set('admin-1');
    const { fixture, q } = await render();
    expect(q('[data-testid="read-only"]')).not.toBeNull();
    // Disabled through its fieldset.
    expect(q('#settings-name')?.matches(':disabled')).toBe(true);
    expect(
      q<HTMLButtonElement>('[data-testid="delete-account"]')?.disabled,
    ).toBe(true);
    fixture.nativeElement.remove();
  });
});
