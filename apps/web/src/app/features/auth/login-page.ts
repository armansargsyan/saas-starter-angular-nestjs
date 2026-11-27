import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
} from '@angular/core';
import {
  NonNullableFormBuilder,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSeparatorImports } from '@spartan-ng/helm/separator';
import { authErrorMessage } from '../../core/auth-errors';
import { safeRedirect } from '../../core/auth.guards';
import { AuthService } from '../../core/auth.service';
import { AuthCard } from './auth-card';
import { FormField } from './form-field';
import { focusFirstInvalid } from './focus-first-invalid';
import { GoogleButton } from './google-button';

@Component({
  selector: 'app-login-page',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    HlmAlertImports,
    HlmButtonImports,
    HlmInputImports,
    HlmSeparatorImports,
    AuthCard,
    FormField,
    GoogleButton,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './login-page.html',
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** `?redirect=` from the signed-in guard. */
  readonly redirect = input<string>();

  protected readonly form = inject(NonNullableFormBuilder).group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });
  protected readonly busy = signal<'email' | 'google' | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly submitted = signal(false);

  protected fieldError(name: 'email' | 'password'): string | null {
    const control = this.form.controls[name];
    if (!(control.touched || this.submitted()) || control.valid) return null;
    if (control.hasError('required'))
      return name === 'email' ? 'Enter your email.' : 'Enter your password.';
    return 'Enter a valid email address.';
  }

  protected async submit(): Promise<void> {
    this.submitted.set(true);
    if (this.form.invalid) {
      focusFirstInvalid(this.host.nativeElement, this.injector);
      return;
    }
    if (this.busy()) return;
    const { email, password } = this.form.getRawValue();
    await this.run('email', () =>
      this.auth.signInWithEmail(email.trim(), password),
    );
  }

  protected google(): Promise<void> {
    return this.run('google', () => this.auth.signInWithGoogle());
  }

  private async run(
    kind: 'email' | 'google',
    action: () => Promise<void>,
  ): Promise<void> {
    if (this.busy()) return;
    this.busy.set(kind);
    this.error.set(null);
    try {
      await action();
      await this.router.navigateByUrl(safeRedirect(this.redirect()));
    } catch (err) {
      this.error.set(authErrorMessage(err));
    } finally {
      this.busy.set(null);
    }
  }
}
