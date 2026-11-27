import { TestBed } from '@angular/core/testing';
import {
  type ActivatedRouteSnapshot,
  convertToParamMap,
  provideRouter,
  type RouterStateSnapshot,
  UrlTree,
} from '@angular/router';
import { FakeAuth } from '../../testing/fake-auth';
import {
  adminGuard,
  safeRedirect,
  signedInGuard,
  signedOutGuard,
} from './auth.guards';
import { AuthService } from './auth.service';

describe('auth guards', () => {
  let auth: FakeAuth;

  beforeEach(() => {
    auth = new FakeAuth();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthService, useValue: auth }],
    });
  });

  const run = (
    guard: typeof signedInGuard,
    url = '/dashboard',
    query: Record<string, string> = {},
  ) =>
    TestBed.runInInjectionContext(() =>
      guard(
        { queryParamMap: convertToParamMap(query) } as ActivatedRouteSnapshot,
        { url } as RouterStateSnapshot,
      ),
    ) as Promise<boolean | UrlTree>;
  const target = (result: boolean | UrlTree) =>
    result instanceof UrlTree ? result.toString() : result;

  it('signedInGuard sends visitors to /login, remembering the page', async () => {
    expect(target(await run(signedInGuard, '/links/abc?x=1'))).toBe(
      '/login?redirect=%2Flinks%2Fabc%3Fx%3D1',
    );
    auth.signIn();
    expect(await run(signedInGuard)).toBe(true);
  });

  it('signedOutGuard sends signed-in users to the dashboard', async () => {
    expect(await run(signedOutGuard)).toBe(true);
    auth.signIn();
    expect(target(await run(signedOutGuard))).toBe('/dashboard');
    // Signed in already: go where the login link was headed (if safe).
    expect(
      target(await run(signedOutGuard, '/login', { redirect: '/links/x' })),
    ).toBe('/links/x');
    expect(
      target(await run(signedOutGuard, '/login', { redirect: '//evil.test' })),
    ).toBe('/dashboard');
  });

  it('adminGuard needs the admin claim', async () => {
    expect(target(await run(adminGuard))).toBe('/login');
    auth.signIn();
    expect(target(await run(adminGuard))).toBe('/dashboard');
    auth.role.set('admin');
    expect(await run(adminGuard)).toBe(true);
  });

  it.each([
    ['/links/abc', '/links/abc'],
    [undefined, '/dashboard'],
    ['', '/dashboard'],
    ['https://evil.test', '/dashboard'],
    ['//evil.test/x', '/dashboard'],
    ['/\\evil.test', '/dashboard'],
    ['javascript:alert(1)', '/dashboard'],
    ['/\t/evil.test', '/dashboard'],
    ['/ok\n', '/dashboard'],
  ])('safeRedirect(%j) → %s', (input, expected) => {
    expect(safeRedirect(input)).toBe(expected);
  });
});
