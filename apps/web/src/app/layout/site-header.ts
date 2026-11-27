import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { AuthService } from '../core/auth.service';

/** Public pages' header: brand, section links, and the session-aware actions. */
@Component({
  selector: 'app-site-header',
  imports: [RouterLink, HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header
      class="bg-background/80 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40 border-b backdrop-blur"
    >
      <div
        class="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:gap-6 sm:px-6"
      >
        <a
          routerLink="/"
          class="flex items-center gap-2 font-semibold tracking-tight"
        >
          <span
            aria-hidden="true"
            class="bg-primary text-primary-foreground grid size-7 place-items-center rounded-md text-xs font-bold"
            >S</span
          >
          <span class="sr-only sm:not-sr-only">SaaS Starter</span>
        </a>
        <nav
          aria-label="Main"
          class="text-muted-foreground flex gap-4 text-sm sm:gap-5"
        >
          <a routerLink="/" fragment="features" class="hover:text-foreground"
            >Features</a
          >
          <a routerLink="/" fragment="pricing" class="hover:text-foreground"
            >Pricing</a
          >
        </nav>
        <div class="ml-auto flex min-h-9 items-center gap-2">
          @if (auth.ready()) {
            @if (auth.signedIn()) {
              <a hlmBtn routerLink="/dashboard" data-testid="header-dashboard"
                >Dashboard</a
              >
            } @else {
              <a hlmBtn variant="ghost" routerLink="/login">Sign in</a>
              <a hlmBtn routerLink="/signup" data-testid="header-signup"
                >Get started</a
              >
            }
          }
        </div>
      </div>
    </header>
  `,
})
export class SiteHeader {
  protected readonly auth = inject(AuthService);
}
