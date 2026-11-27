import { OVERLAY_DEFAULT_CONFIG } from '@angular/cdk/overlay';
import type { Route } from '@angular/router';
import { adminGuard } from '../core/auth.guards';
import { AppShell } from './app-shell';

/**
 * The signed-in app (loaded lazily, behind signedInGuard). Overlay settings
 * live here rather than in app.config: importing the CDK overlay token at
 * the root would pull the whole overlay engine into the initial bundle.
 */
export const SIGNED_IN_ROUTES: Route[] = [
  {
    path: '',
    component: AppShell,
    providers: [
      // What `provideSpartanHlm()` sets: overlays stay out of the popover top layer.
      { provide: OVERLAY_DEFAULT_CONFIG, useValue: { usePopover: false } },
    ],
    children: [
      {
        path: 'dashboard',
        title: 'Links · SaaS Starter',
        loadComponent: () =>
          import('../features/dashboard/dashboard-page').then(
            (m) => m.DashboardPage,
          ),
      },
      {
        path: 'links/:code',
        title: 'Link stats · SaaS Starter',
        loadComponent: () =>
          import('../features/links/link-detail-page').then(
            (m) => m.LinkDetailPage,
          ),
      },
      {
        path: 'billing',
        title: 'Billing · SaaS Starter',
        loadComponent: () =>
          import('../features/billing/billing-page').then((m) => m.BillingPage),
      },
      {
        path: 'teams',
        title: 'Teams · SaaS Starter',
        loadComponent: () =>
          import('../features/teams/teams-page').then((m) => m.TeamsPage),
      },
      {
        path: 'admin',
        title: 'Admin · SaaS Starter',
        canActivate: [adminGuard],
        loadComponent: () =>
          import('../features/admin/admin-page').then((m) => m.AdminPage),
      },
    ],
  },
];
