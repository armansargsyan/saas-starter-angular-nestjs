import { OVERLAY_DEFAULT_CONFIG } from '@angular/cdk/overlay';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { FakeAuth } from '../../testing/fake-auth';
import { settle } from '../../testing/settle';
import { AuthService } from '../core/auth.service';
import { THEME_STORAGE_KEY, ThemeService } from '../core/theme.service';
import { AccountMenu } from './account-menu';

describe('AccountMenu', () => {
  let auth: FakeAuth;

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
    auth = new FakeAuth();
    auth.signIn('u1', { displayName: 'Ada Lovelace' });
    TestBed.configureTestingModule({
      imports: [AccountMenu],
      providers: [
        provideRouter([{ path: '**', children: [] }]),
        { provide: AuthService, useValue: auth },
        { provide: OVERLAY_DEFAULT_CONFIG, useValue: { usePopover: false } },
      ],
    });
  });

  afterEach(() => {
    // Close any overlay left open.
    document.querySelectorAll('.cdk-overlay-container').forEach((c) => {
      c.innerHTML = '';
    });
  });

  async function open() {
    const fixture = TestBed.createComponent(AccountMenu);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLElement>('[data-testid="account-menu"]')?.click();
    await fixture.whenStable();
    return { fixture, el };
  }

  const inMenu = <T extends HTMLElement>(selector: string) =>
    document.querySelector<T>(`.cdk-overlay-container ${selector}`);

  it('shows initials, the name, and an accessible name with it', async () => {
    const fixture = TestBed.createComponent(AccountMenu);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(
      el.querySelector('[data-testid="avatar-initials"]')?.textContent?.trim(),
    ).toBe('AL');
    expect(el.querySelector('[data-testid="account-name"]')?.textContent).toBe(
      'Ada Lovelace',
    );
    expect(
      el
        .querySelector('[data-testid="account-menu"]')
        ?.getAttribute('aria-label'),
    ).toBe('Account menu, Ada Lovelace');
  });

  it('shows the picture once set, through the avatar', async () => {
    auth.signIn('u1', { photoURL: 'https://example.com/a.png' });
    const fixture = TestBed.createComponent(AccountMenu);
    await fixture.whenStable();
    const img = (fixture.nativeElement as HTMLElement).querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://example.com/a.png');
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(img?.getAttribute('alt')).toBe('');
  });

  it('never loads a non-https picture', async () => {
    auth.signIn('u1', { photoURL: 'http://example.com/a.png' });
    const fixture = TestBed.createComponent(AccountMenu);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('img')).toBe(
      null,
    );
  });

  it('links to settings and switches the theme from the menu', async () => {
    const { fixture } = await open();
    expect(inMenu('[data-testid="menu-settings"]')?.getAttribute('href')).toBe(
      '/settings',
    );
    expect(inMenu('[data-testid="account-summary"]')?.textContent).toContain(
      'u1@example.com',
    );

    const system = inMenu('[data-theme-option="system"]');
    expect(system?.getAttribute('role')).toBe('menuitemradio');
    expect(system?.getAttribute('aria-checked')).toBe('true');

    inMenu('[data-theme-option="dark"]')?.click();
    await fixture.whenStable();
    expect(TestBed.inject(ThemeService).preference()).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(
      inMenu('[data-theme-option="dark"]')?.getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('signs out to the home page', async () => {
    const navigate = vi
      .spyOn(TestBed.inject(Router), 'navigateByUrl')
      .mockResolvedValue(true);
    await open();
    inMenu('[data-testid="menu-sign-out"]')?.click();
    await settle();
    expect(auth.signOut).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('stops impersonating back to the admin login', async () => {
    auth.impersonatedBy.set('admin-1');
    const navigate = vi
      .spyOn(TestBed.inject(Router), 'navigateByUrl')
      .mockResolvedValue(true);
    await open();
    const item = inMenu('[data-testid="menu-sign-out"]');
    expect(item?.textContent).toContain('Stop impersonating');
    item?.click();
    await settle();
    expect(auth.signOut).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/login?redirect=%2Fadmin');
  });
});
