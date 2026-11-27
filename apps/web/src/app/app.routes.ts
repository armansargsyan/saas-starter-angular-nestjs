import { Route } from '@angular/router';
import { adminGuard, signedInGuard, signedOutGuard } from './core/auth.guards';

export const appRoutes: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    title: 'SaaS Starter: short links with analytics',
    loadComponent: () =>
      import('./features/landing/landing-page').then((m) => m.LandingPage),
  },
  {
    path: 'login',
    title: 'Sign in · SaaS Starter',
    canActivate: [signedOutGuard],
    loadComponent: () =>
      import('./features/auth/login-page').then((m) => m.LoginPage),
  },
  {
    path: 'signup',
    title: 'Create your account · SaaS Starter',
    canActivate: [signedOutGuard],
    loadComponent: () =>
      import('./features/auth/signup-page').then((m) => m.SignupPage),
  },
  {
    path: 'reset-password',
    title: 'Reset your password · SaaS Starter',
    loadComponent: () =>
      import('./features/auth/reset-password-page').then(
        (m) => m.ResetPasswordPage,
      ),
  },
  {
    path: 'verify-email',
    title: 'Verify your email · SaaS Starter',
    canActivate: [signedInGuard],
    loadComponent: () =>
      import('./features/auth/verify-email-page').then(
        (m) => m.VerifyEmailPage,
      ),
  },
  {
    path: 'dashboard',
    title: 'Dashboard · SaaS Starter',
    canActivate: [signedInGuard],
    loadComponent: () =>
      import('./features/dashboard/dashboard-page').then(
        (m) => m.DashboardPage,
      ),
  },
  {
    path: 'admin',
    title: 'Admin · SaaS Starter',
    canActivate: [signedInGuard, adminGuard],
    loadComponent: () =>
      import('./features/admin/admin-page').then((m) => m.AdminPage),
  },
  { path: '**', redirectTo: '' },
];
