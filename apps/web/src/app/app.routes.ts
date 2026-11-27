import { Route } from '@angular/router';

export const appRoutes: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    title: 'SaaS Starter: short links with analytics',
    loadComponent: () =>
      import('./features/landing/landing-page').then((m) => m.LandingPage),
  },
  { path: '**', redirectTo: '' },
];
