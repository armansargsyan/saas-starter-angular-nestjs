import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  signal,
} from '@angular/core';
import {
  NonNullableFormBuilder,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { RouterLink } from '@angular/router';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { authErrorMessage } from '../../core/auth-errors';
import { AuthService } from '../../core/auth.service';
import { AuthCard } from './auth-card';
import { focusFirstInvalid } from './focus-first-invalid';
import { FormField } from './form-field';

@Component({
  selector: 'app-reset-password-page',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    HlmAlertImports,
    HlmButtonImports,
    HlmInputImports,
    AuthCard,
    FormField,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-auth-card
      heading="Reset your password"
      description="We’ll email you a link to choose a new password."
    >
      <!-- Mounted from the start so the confirmation is announced. -->
      <div role="status">
        @if (sentTo()) {
          <div hlmAlert tabindex="-1" id="reset-sent" data-testid="sent">
            <p hlmAlertDescription>
              If an account exists for <strong>{{ sentTo() }}</strong>, a reset
              link is on its way. Check your inbox (and spam folder).
            </p>
          </div>
        }
      </div>
      @if (!sentTo()) {
        <form
          class="grid gap-4"
          [formGroup]="form"
          (ngSubmit)="submit()"
          novalidate
        >
          <app-form-field for="email" label="Email" [error]="emailError()">
            <input
              hlmInput
              id="email"
              type="email"
              autocomplete="email"
              formControlName="email"
              [forceInvalid]="!!emailError()"
              [attr.aria-invalid]="emailError() ? 'true' : null"
              [attr.aria-describedby]="emailError() ? 'email-error' : null"
            />
          </app-form-field>
          <div role="alert">
            @if (error()) {
              <div hlmAlert variant="destructive" data-testid="auth-error">
                <p hlmAlertDescription>{{ error() }}</p>
              </div>
            }
          </div>
          <button
            hlmBtn
            type="submit"
            class="w-full aria-disabled:opacity-60"
            [attr.aria-disabled]="busy() ? 'true' : null"
            [attr.aria-busy]="busy()"
            data-testid="submit"
          >
            {{ busy() ? 'Sending…' : 'Send reset link' }}
          </button>
        </form>
      }
      <p authFooter>
        <a
          routerLink="/login"
          class="text-foreground font-medium underline-offset-4 hover:underline"
          >Back to sign in</a
        >
      </p>
    </app-auth-card>
  `,
})
export class ResetPasswordPage {
  private readonly auth = inject(AuthService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly form = inject(NonNullableFormBuilder).group({
    email: ['', [Validators.required, Validators.email]],
  });
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly sentTo = signal<string | null>(null);
  private readonly submitted = signal(false);

  protected emailError(): string | null {
    const control = this.form.controls.email;
    if (!(control.touched || this.submitted()) || control.valid) return null;
    return control.hasError('required')
      ? 'Enter your email.'
      : 'Enter a valid email address.';
  }

  protected async submit(): Promise<void> {
    this.submitted.set(true);
    if (this.form.invalid) {
      focusFirstInvalid(this.host.nativeElement, this.injector);
      return;
    }
    if (this.busy()) return;
    const email = this.form.getRawValue().email.trim();
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.sendPasswordReset(email);
      this.sentTo.set(email);
      // The form (and its focused button) is gone: move focus to the message.
      afterNextRender(
        () =>
          this.host.nativeElement
            .querySelector<HTMLElement>('#reset-sent')
            ?.focus(),
        { injector: this.injector },
      );
    } catch (err) {
      this.error.set(authErrorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
