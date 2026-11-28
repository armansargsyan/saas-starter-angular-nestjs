import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronDown,
  lucideLogOut,
  lucideSettings,
} from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { AuthService } from '../core/auth.service';
import {
  THEME_LABELS,
  THEME_PREFERENCES,
  ThemeService,
} from '../core/theme.service';
import { UserAvatar } from './user-avatar';

/** The header's account button: settings, theme and sign out. */
@Component({
  selector: 'app-account-menu',
  imports: [
    RouterLink,
    NgIcon,
    HlmButtonImports,
    HlmDropdownMenuImports,
    UserAvatar,
  ],
  providers: [
    provideIcons({ lucideChevronDown, lucideLogOut, lucideSettings }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      hlmBtn
      variant="ghost"
      type="button"
      class="h-9 gap-2 px-1.5 md:px-2"
      [hlmDropdownMenuTrigger]="menu"
      align="end"
      [attr.aria-label]="'Account menu, ' + label()"
      data-testid="account-menu"
    >
      <app-user-avatar
        [photoURL]="user()?.photoURL"
        [displayName]="user()?.displayName"
        [email]="user()?.email"
      />
      <span
        class="text-muted-foreground hidden max-w-48 truncate font-normal md:inline"
        data-testid="account-name"
        >{{ label() }}</span
      >
      <ng-icon
        name="lucideChevronDown"
        class="text-muted-foreground hidden md:inline"
        aria-hidden="true"
      />
    </button>

    <ng-template #menu>
      <hlm-dropdown-menu class="w-60">
        <div class="px-2 py-1.5 text-sm" data-testid="account-summary">
          @if (user()?.displayName; as name) {
            <p class="truncate font-medium">{{ name }}</p>
          }
          <p class="text-muted-foreground truncate">{{ user()?.email }}</p>
        </div>
        <hlm-dropdown-menu-separator />
        <a
          hlmDropdownMenuItem
          routerLink="/settings"
          data-testid="menu-settings"
        >
          <ng-icon name="lucideSettings" aria-hidden="true" />
          Settings
        </a>
        <hlm-dropdown-menu-separator />
        <hlm-dropdown-menu-label id="theme-menu-label"
          >Theme</hlm-dropdown-menu-label
        >
        <hlm-dropdown-menu-group aria-labelledby="theme-menu-label">
          @for (option of themes; track option) {
            <button
              hlmDropdownMenuRadio
              type="button"
              [checked]="theme.preference() === option"
              (triggered)="theme.set(option)"
              [attr.data-theme-option]="option"
            >
              {{ themeLabels[option] }}
              <hlm-dropdown-menu-radio-indicator />
            </button>
          }
        </hlm-dropdown-menu-group>
        <hlm-dropdown-menu-separator />
        <button
          hlmDropdownMenuItem
          type="button"
          (triggered)="signOut()"
          data-testid="menu-sign-out"
        >
          <ng-icon name="lucideLogOut" aria-hidden="true" />
          {{ auth.impersonatedBy() ? 'Stop impersonating' : 'Sign out' }}
        </button>
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class AccountMenu {
  protected readonly auth = inject(AuthService);
  protected readonly theme = inject(ThemeService);
  private readonly router = inject(Router);

  protected readonly user = this.auth.user;
  protected readonly label = computed(
    () => this.user()?.displayName || this.user()?.email || 'Account',
  );
  protected readonly themes = THEME_PREFERENCES;
  protected readonly themeLabels = THEME_LABELS;

  /** Stopping an impersonation returns the admin to the admin login, like the banner. */
  protected async signOut(): Promise<void> {
    const impersonating = this.auth.impersonatedBy() !== null;
    await this.auth.signOut();
    await this.router.navigateByUrl(
      impersonating ? '/login?redirect=%2Fadmin' : '/',
    );
  }
}
