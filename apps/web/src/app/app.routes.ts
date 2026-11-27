import { Route } from '@angular/router';

export const appRoutes: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    title: 'SaaS Starter',
    loadComponent: () =>
      import('./features/home/home-page').then((m) => m.HomePage),
  },
  { path: '**', redirectTo: '' },
];
