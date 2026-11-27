import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { AuthService } from '../../core/auth.service';

/** Placeholder: the links dashboard arrives in #11. */
@Component({
  selector: 'app-dashboard-page',
  imports: [RouterLink, HlmAlertImports, HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main id="main" class="mx-auto max-w-3xl px-4 py-10">
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
      <h1 class="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p class="text-muted-foreground mt-2">
        Signed in as {{ auth.user()?.email }}.
      </p>
      <button
        hlmBtn
        variant="outline"
        type="button"
        class="mt-6"
        (click)="signOut()"
      >
        Sign out
      </button>
    </main>
  `,
})
export class DashboardPage {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** Only password accounts verify by email (Google accounts are verified). */
  protected readonly needsVerification = computed(() => {
    const user = this.auth.user();
    return !!user && !user.emailVerified && user.providers.includes('password');
  });

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigateByUrl('/');
  }
}
