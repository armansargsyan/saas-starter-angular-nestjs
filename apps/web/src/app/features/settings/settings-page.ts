import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  linkedSignal,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideMonitor, lucideMoon, lucideSun } from '@ng-icons/lucide';
import {
  AVATAR_URL_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  updateProfileSchema,
} from '@saas-starter/shared';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmAlertDialogImports } from '@spartan-ng/helm/alert-dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { AccountApi } from '../../core/account.api';
import { authErrorMessage } from '../../core/auth-errors';
import { AuthService } from '../../core/auth.service';
import { ACCOUNT_DELETED_STATE } from '../../core/navigation-state';
import {
  THEME_LABELS,
  THEME_PREFERENCES,
  type ThemePreference,
  ThemeService,
} from '../../core/theme.service';
import { UserAvatar } from '../../layout/user-avatar';
import { FormField } from '../auth/form-field';

type Field = 'displayName' | 'photoURL';

const THEME_ICONS: Record<ThemePreference, string> = {
  light: 'lucideSun',
  dark: 'lucideMoon',
  system: 'lucideMonitor',
};

@Component({
  selector: 'app-settings-page',
  imports: [
    RouterLink,
    NgIcon,
    HlmAlertImports,
    HlmAlertDialogImports,
    HlmButtonImports,
    HlmCardImports,
    HlmInputImports,
    FormField,
    UserAvatar,
  ],
  providers: [provideIcons({ lucideMonitor, lucideMoon, lucideSun })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings-page.html',
})
export class SettingsPage {
  private readonly api = inject(AccountApi);
  protected readonly auth = inject(AuthService);
  protected readonly theme = inject(ThemeService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly user = this.auth.user;
  /** Impersonated sessions are read-only (the api enforces it too). */
  protected readonly readOnly = computed(
    () => this.auth.impersonatedBy() !== null,
  );

  // Profile
  protected readonly maxName = DISPLAY_NAME_MAX_LENGTH;
  protected readonly maxUrl = AVATAR_URL_MAX_LENGTH;
  /**
   * The form's values. A profile change from elsewhere (e.g. a reload of the
   * Firebase user) flows in, unless the field has unsaved edits: those stay.
   */
  protected readonly name = linkedSignal<string, string>({
    source: () => this.user()?.displayName ?? '',
    computation: keepUnsavedEdits,
  });
  protected readonly photo = linkedSignal<string, string>({
    source: () => this.user()?.photoURL ?? '',
    computation: keepUnsavedEdits,
  });
  protected readonly saving = signal(false);
  private readonly fieldErrors = signal<Partial<Record<Field, string>>>({});
  protected readonly profileError = signal<string | null>(null);
  /** Shown next to the form; also announced. */
  protected readonly profileSaved = signal(false);
  protected readonly dirty = computed(
    () =>
      this.name().trim() !== (this.user()?.displayName ?? '') ||
      this.photo().trim() !== (this.user()?.photoURL ?? ''),
  );

  // Appearance
  protected readonly themes = THEME_PREFERENCES;
  protected readonly themeLabels = THEME_LABELS;
  protected readonly themeIcons = THEME_ICONS;

  // Deletion
  /** What to type: the email, or "delete" for an account without one. */
  protected readonly confirmPhrase = computed(
    () => this.user()?.email ?? 'delete',
  );
  protected readonly confirmText = signal('');
  protected readonly confirmed = computed(
    () =>
      this.confirmText().trim().toLowerCase() ===
      this.confirmPhrase().toLowerCase(),
  );
  protected readonly confirmError = signal<string | null>(null);
  protected readonly deleting = signal(false);
  protected readonly deleteError = signal<string | null>(null);
  /** Teams that block deletion (owned, with other members). */
  protected readonly blockingTeams = signal<{ id: string; name: string }[]>([]);
  /**
   * Set when the api wants a fresh sign-in first (requires_recent_login):
   * how to prove it's you, by the account's sign-in method.
   */
  protected readonly reauth = signal<'password' | 'google' | null>(null);
  protected readonly reauthPassword = signal('');
  /** The api didn't accept the session (401): offer to sign in again. */
  protected readonly sessionExpired = signal(false);

  protected error(field: Field): string | null {
    return this.fieldErrors()[field] ?? null;
  }

  protected onInput(field: Field, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    (field === 'displayName' ? this.name : this.photo).set(value);
    this.fieldErrors.update((errors) => ({ ...errors, [field]: undefined }));
    this.profileSaved.set(false);
  }

  protected async saveProfile(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving() || this.readOnly() || !this.dirty()) return;
    this.profileError.set(null);
    this.profileSaved.set(false);

    const parsed = updateProfileSchema.safeParse({
      displayName: this.name(),
      photoURL: this.photo(),
    });
    if (!parsed.success) {
      const errors: Partial<Record<Field, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as Field | undefined;
        if (field && !errors[field]) {
          errors[field] = sentence(issue.message, field);
        }
      }
      this.fieldErrors.set(errors);
      this.focusFirst('[aria-invalid="true"]');
      return;
    }
    this.fieldErrors.set({});

    this.saving.set(true);
    // The api parses the same schema; send what was typed.
    const result = await this.api.updateProfile({
      displayName: this.name(),
      photoURL: this.photo(),
    });
    if (result.ok) await this.auth.refreshProfile(result.value);
    this.saving.set(false);

    if (!result.ok) {
      const fields = result.error.fields as Partial<Record<Field, string>>;
      if (fields.displayName || fields.photoURL) {
        this.fieldErrors.set({
          ...(fields.displayName && { displayName: fields.displayName }),
          ...(fields.photoURL && { photoURL: fields.photoURL }),
        });
        this.focusFirst('[aria-invalid="true"]');
      } else {
        this.profileError.set(result.error.message);
      }
      return;
    }
    // Show what was stored (trimmed, normalized).
    this.name.set(result.value.displayName ?? '');
    this.photo.set(result.value.photoURL ?? '');
    this.profileSaved.set(true);
  }

  protected setTheme(preference: ThemePreference): void {
    this.theme.set(preference);
  }

  /** Each opening starts over. */
  protected resetDeletion(): void {
    this.confirmText.set('');
    this.confirmError.set(null);
    this.deleteError.set(null);
    this.blockingTeams.set([]);
    this.reauth.set(null);
    this.reauthPassword.set('');
    this.sessionExpired.set(false);
  }

  protected onConfirmInput(event: Event): void {
    this.confirmText.set((event.target as HTMLInputElement).value);
    this.confirmError.set(null);
  }

  protected onReauthPassword(event: Event): void {
    this.reauthPassword.set((event.target as HTMLInputElement).value);
  }

  /** The form's submit: confirms (and, if asked, re-authenticates), then deletes. */
  protected async deleteAccount(close: () => void): Promise<void> {
    // Enter in a field submits too: a Google account still confirms in the
    // popup (a keyboard submit is a user gesture as well).
    if (this.reauth() === 'google') return this.reauthWithGoogle(close);
    if (this.deleting() || this.readOnly() || !this.checkConfirmed()) return;
    if (this.reauth() === 'password') {
      const password = this.reauthPassword();
      if (!password) {
        this.deleteError.set('Enter your password to continue.');
        this.focusById('delete-password');
        return;
      }
      this.deleting.set(true);
      try {
        await this.auth.reauthenticateWithPassword(password);
      } catch (err) {
        this.deleting.set(false);
        this.deleteError.set(authErrorMessage(err));
        this.focusById('delete-password');
        return;
      }
    }
    await this.requestDeletion(close);
  }

  /**
   * Google accounts confirm in a popup. Nothing is awaited before it opens,
   * so browsers keep the click's user gesture.
   */
  protected reauthWithGoogle(close: () => void): void {
    if (this.deleting() || this.readOnly() || !this.checkConfirmed()) return;
    this.deleting.set(true);
    this.deleteError.set(null);
    this.auth.reauthenticateWithGoogle().then(
      () => this.requestDeletion(close),
      (err: unknown) => {
        this.deleting.set(false);
        this.deleteError.set(authErrorMessage(err));
      },
    );
  }

  private checkConfirmed(): boolean {
    if (this.confirmed()) return true;
    this.confirmError.set(`Type ${this.confirmPhrase()} to confirm.`);
    this.focusById('delete-confirm');
    return false;
  }

  private async requestDeletion(close: () => void): Promise<void> {
    this.deleteError.set(null);
    this.blockingTeams.set([]);
    this.sessionExpired.set(false);
    this.deleting.set(true);
    const result = await this.api.deleteAccount();
    if (result.ok) return this.finishDeleted(close);

    const { error } = result;
    // The account may be gone after all (an earlier answer got lost, or this
    // one did): only Firebase saying so counts. A 401 alone can also mean a
    // revoked session or a token that couldn't be refreshed.
    const unclear =
      error.status === 401 || error.status === 0 || error.status >= 500;
    if (unclear && (await this.auth.isAccountGone())) {
      return this.finishDeleted(close);
    }
    this.deleting.set(false);
    if (error.status === 401) {
      this.sessionExpired.set(true);
      this.deleteError.set(
        'Your session expired. Sign in again, then delete your account.',
      );
      return;
    }
    if (error.code === 'requires_recent_login') {
      const mode = this.user()?.providers.includes('password')
        ? 'password'
        : 'google';
      this.reauth.set(mode);
      this.deleteError.set(
        mode === 'password'
          ? 'For your security, enter your password to delete your account.'
          : 'For your security, confirm with Google to delete your account.',
      );
      if (mode === 'password') this.focusById('delete-password');
      return;
    }
    this.blockingTeams.set(error.teams ?? []);
    this.deleteError.set(error.message);
  }

  /** Back to this page after signing in again. */
  protected async signInAgain(close: () => void): Promise<void> {
    close();
    try {
      await this.auth.signOut();
    } catch {
      // Already signed out.
    }
    await this.router.navigate(['/login'], {
      queryParams: { redirect: '/settings' },
    });
  }

  private async finishDeleted(close: () => void): Promise<void> {
    close();
    // The account is gone; signing out only clears this browser's session.
    try {
      await this.auth.signOut();
    } catch {
      // Nothing left to sign out of.
    }
    await this.router.navigateByUrl('/', {
      state: { [ACCOUNT_DELETED_STATE]: true },
    });
  }

  private focusFirst(selector: string): void {
    afterNextRender(
      () =>
        this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(),
      { injector: this.injector },
    );
  }

  /** The dialog renders in an overlay: find its controls by id. */
  private focusById(id: string): void {
    afterNextRender(() => document.getElementById(id)?.focus(), {
      injector: this.injector,
    });
  }
}

/** Turns a schema message ("must be an https:// URL") into a sentence. */
function sentence(message: string, field: Field): string {
  const subject = field === 'displayName' ? 'The name' : 'The picture URL';
  if (/^(must|is) /.test(message)) return `${subject} ${message}.`;
  return message.endsWith('.') ? message : `${message}.`;
}

/**
 * linkedSignal computation for a form field: follow the stored value, but
 * keep what the user typed if it differed from the value it started from.
 */
function keepUnsavedEdits(
  next: string,
  previous?: { source: string; value: string },
): string {
  return previous && previous.value !== previous.source ? previous.value : next;
}
