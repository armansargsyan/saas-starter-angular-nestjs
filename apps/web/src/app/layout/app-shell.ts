import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { AuthService } from '../core/auth.service';
import { WorkspaceService } from '../core/workspace.service';
import { WorkspaceSwitcher } from './workspace-switcher';

/** Layout of the signed-in area: nav, account actions, session banners. */
@Component({
  selector: 'app-shell',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    HlmAlertImports,
    HlmButtonImports,
    WorkspaceSwitcher,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a
      href="#main"
      class="bg-background focus:ring-ring sr-only z-50 rounded-md px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:ring-2"
      >Skip to content</a
    >
    <header class="bg-background sticky top-0 z-40 border-b">
      <div
        class="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:gap-6 sm:px-6"
      >
        <a
          routerLink="/dashboard"
          class="flex items-center gap-2 font-semibold tracking-tight"
        >
          <span
            aria-hidden="true"
            class="bg-primary text-primary-foreground grid size-7 place-items-center rounded-md text-xs font-bold"
            >S</span
          >
          <span class="sr-only sm:not-sr-only">SaaS Starter</span>
        </a>
        <nav aria-label="App" class="flex gap-1 text-sm">
          @for (item of nav; track item.path) {
            <a
              [routerLink]="item.path"
              routerLinkActive="bg-muted text-foreground"
              ariaCurrentWhenActive="page"
              class="text-muted-foreground hover:text-foreground rounded-md px-2.5 py-1.5"
              >{{ item.label }}</a
            >
          }
          @if (auth.isAdmin()) {
            <a
              routerLink="/admin"
              routerLinkActive="bg-muted text-foreground"
              ariaCurrentWhenActive="page"
              class="text-muted-foreground hover:text-foreground rounded-md px-2.5 py-1.5"
              >Admin</a
            >
          }
        </nav>
        <div class="ml-auto flex items-center gap-3 text-sm">
          <app-workspace-switcher class="hidden sm:block" />
          <span
            class="text-muted-foreground hidden max-w-48 truncate md:inline"
            data-testid="account-email"
          >
            {{ auth.user()?.email }}
          </span>
          <button
            hlmBtn
            variant="outline"
            size="sm"
            type="button"
            (click)="signOut()"
          >
            Sign out
          </button>
        </div>
      </div>
      @if (workspaces.teams().length) {
        <!-- Narrow screens: the switcher gets its own row. -->
        <div class="border-t px-4 py-2 sm:hidden">
          <app-workspace-switcher selectId="workspace-switcher-narrow" />
        </div>
      }
    </header>

    @if (auth.impersonatedBy()) {
      <div
        class="border-b bg-amber-50 text-amber-950 dark:bg-amber-950 dark:text-amber-50"
        role="status"
      >
        <p
          class="mx-auto max-w-6xl px-4 py-2 text-sm sm:px-6"
          data-testid="impersonation-banner"
        >
          You’re viewing this account as an admin (read-only).
          <button
            type="button"
            class="font-medium underline underline-offset-4"
            (click)="signOut()"
          >
            Stop impersonating
          </button>
        </p>
      </div>
    }

    <main
      id="main"
      tabindex="-1"
      class="mx-auto max-w-6xl px-4 py-8 outline-none sm:px-6"
    >
      @if (needsVerification()) {
        <div hlmAlert class="mb-6" data-testid="verify-banner">
          <p hlmAlertDescription>
            Please verify your email address.
            <a
              routerLink="/verify-email"
              class="font-medium underline underline-offset-4"
              >Verify now</a
            >
          </p>
        </div>
      }
      <router-outlet />
    </main>
  `,
})
export class AppShell {
  protected readonly auth = inject(AuthService);
  protected readonly workspaces = inject(WorkspaceService);
  private readonly router = inject(Router);

  protected readonly nav = [
    { path: '/dashboard', label: 'Links' },
    { path: '/teams', label: 'Teams' },
    { path: '/billing', label: 'Billing' },
  ];

  /** Only password accounts verify by email (Google accounts are verified). */
  protected needsVerification(): boolean {
    const user = this.auth.user();
    return !!user && !user.emailVerified && user.providers.includes('password');
  }

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigateByUrl('/');
  }
}
