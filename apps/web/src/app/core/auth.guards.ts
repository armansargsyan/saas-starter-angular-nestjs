import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/** Signed-in only; otherwise to /login, remembering where they were going. */
export const signedInGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.whenReady();
  return (
    auth.signedIn() ||
    router.createUrlTree(['/login'], { queryParams: { redirect: state.url } })
  );
};

/** Login and sign-up pages: signed-in users go straight on (to `?redirect=` if safe). */
export const signedOutGuard: CanActivateFn = async (route) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.whenReady();
  return (
    !auth.signedIn() ||
    router.parseUrl(safeRedirect(route.queryParamMap.get('redirect')))
  );
};

/**
 * Admin pages (UI only: every admin api call is checked server-side).
 * Non-admins land on the dashboard.
 */
export const adminGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const role = await auth.currentRole();
  if (role === null) return router.createUrlTree(['/login']);
  return role === 'admin' || router.createUrlTree(['/dashboard']);
};

/** Only follow same-app redirects (`/path`), never `//host` or absolute URLs. */
export function safeRedirect(
  value: string | null | undefined,
  fallback = '/dashboard',
): string {
  // One leading slash; no backslashes or control characters anywhere
  // (browsers read `/\host` and `/<TAB>/host` like `//host`).
  const safe =
    !!value &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    // eslint-disable-next-line no-control-regex
    !/[\\\u0000-\u001f\u007f]/.test(value);
  return safe ? value : fallback;
}
