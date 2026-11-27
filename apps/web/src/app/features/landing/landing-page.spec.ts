import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { FakeAuth } from '../../../testing/fake-auth';
import { AuthService } from '../../core/auth.service';
import { LandingPage } from './landing-page';

describe('LandingPage', () => {
  let auth: FakeAuth;

  beforeEach(() => {
    auth = new FakeAuth();
    TestBed.configureTestingModule({
      imports: [LandingPage],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: auth },
      ],
    });
  });

  async function render() {
    const fixture = TestBed.createComponent(LandingPage);
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('has one h1, a features section, the pricing table and landmarks', async () => {
    const { el } = await render();
    expect(el.querySelectorAll('h1')).toHaveLength(1);
    expect(el.querySelector('#features')?.querySelectorAll('li')).toHaveLength(
      6,
    );
    expect(el.querySelector('#pricing app-pricing-table')).not.toBeNull();
    expect(el.querySelector('header')).not.toBeNull();
    expect(el.querySelector('main')).not.toBeNull();
    expect(el.querySelector('footer')).not.toBeNull();
    // Skip link to a focusable main.
    expect(el.querySelector('a[href="#main"]')?.textContent).toContain(
      'Skip to content',
    );
    expect(el.querySelector('main')?.getAttribute('tabindex')).toBe('-1');
  });

  it('points the CTAs at sign up when signed out, and the dashboard when signed in', async () => {
    const { fixture, el } = await render();
    const hero = () =>
      el.querySelector('[data-testid="hero-cta"]')?.getAttribute('href');
    expect(hero()).toBe('/signup');
    expect(el.querySelector('[data-testid="header-signup"]')).not.toBeNull();

    auth.signIn();
    await fixture.whenStable();
    expect(hero()).toBe('/dashboard');
    expect(el.querySelector('[data-testid="header-dashboard"]')).not.toBeNull();
  });

  it('shows no session actions until the auth state is known (no flicker)', async () => {
    auth.state.set(undefined);
    const { el } = await render();
    expect(el.querySelector('[data-testid="hero-cta"]')?.classList).toContain(
      'invisible',
    );
    // "See pricing" doesn't depend on the session.
    expect(el.querySelector('a[href="#pricing"]')?.classList).not.toContain(
      'invisible',
    );
    expect(el.querySelector('[data-testid="header-signup"]')).toBeNull();
    expect(el.querySelector('[data-testid="header-dashboard"]')).toBeNull();
  });
});
