import {
  ChangeDetectionStrategy,
  Component,
  computed,
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
import { PLANS } from '@saas-starter/shared';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSeparatorImports } from '@spartan-ng/helm/separator';
import { authErrorMessage } from '../../core/auth-errors';
import { safeRedirect } from '../../core/auth.guards';
import { AuthService } from '../../core/auth.service';
import { BillingService } from '../../core/billing.service';
import { AuthCard } from './auth-card';
import { FormField } from './form-field';
import { focusFirstInvalid } from './focus-first-invalid';
import { GoogleButton } from './google-button';

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_NAME_LENGTH = 80;

@Component({
  selector: 'app-signup-page',
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
  templateUrl: './signup-page.html',
})
export class SignupPage {
  private readonly auth = inject(AuthService);
  private readonly billing = inject(BillingService);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** `?redirect=` carried over from /login. */
  readonly redirect = input<string>();

  /** `?plan=pro|team` from the pricing table. */
  readonly plan = input<string>();
  protected readonly chosenPlan = computed(() => {
    const plan = this.plan();
    return plan === 'pro' || plan === 'team' ? PLANS[plan] : null;
  });

  protected readonly description = computed(() =>
    this.chosenPlan()
      ? 'Create your account first; you can cancel any time.'
      : 'Free for up to 10 links. No card needed.',
  );

  protected readonly minLength = MIN_PASSWORD_LENGTH;
  protected readonly maxNameLength = MAX_NAME_LENGTH;
  protected readonly form = inject(NonNullableFormBuilder).group({
    name: ['', [Validators.maxLength(MAX_NAME_LENGTH)]],
    email: ['', [Validators.required, Validators.email]],
    password: [
      '',
      [Validators.required, Validators.minLength(MIN_PASSWORD_LENGTH)],
    ],
  });
  protected readonly busy = signal<'email' | 'google' | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly submitted = signal(false);
  /** Account created, but Stripe Checkout couldn't start. */
  protected readonly checkoutFailed = signal(false);

  protected fieldError(name: 'name' | 'email' | 'password'): string | null {
    const control = this.form.controls[name];
    if (!(control.touched || this.submitted()) || control.valid) return null;
    if (name === 'name') return `Use at most ${MAX_NAME_LENGTH} characters.`;
    if (name === 'email') {
      return control.hasError('required')
        ? 'Enter your email.'
        : 'Enter a valid email address.';
    }
    return control.hasError('required')
      ? 'Choose a password.'
      : `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }

  protected async submit(): Promise<void> {
    this.submitted.set(true);
    if (this.form.invalid) {
      focusFirstInvalid(this.host.nativeElement, this.injector);
      return;
    }
    if (this.busy()) return;
    const { name, email, password } = this.form.getRawValue();
    await this.run('email', () =>
      this.auth.signUpWithEmail(email.trim(), password, name.trim()),
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
    let leaving = false;
    try {
      await action();
      leaving = await this.continueAfterSignup(kind);
    } catch (err) {
      this.error.set(authErrorMessage(err));
    } finally {
      // Leaving for Stripe: stay busy so nothing can be pressed twice.
      if (!leaving) this.busy.set(null);
    }
  }

  /**
   * Carry on with the chosen plan; otherwise password accounts verify their
   * email first and Google ones go where they were headed.
   */
  /** True when the browser is leaving for Stripe Checkout. */
  private async continueAfterSignup(
    kind: 'email' | 'google',
  ): Promise<boolean> {
    const plan = this.chosenPlan()?.id;
    const uid = this.auth.user()?.uid;
    if (plan === 'pro' && uid) {
      const outcome = await this.billing.startCheckout({
        workspaceId: uid,
        plan: 'pro',
      });
      if (outcome.ok) return true;
      // The account exists; say what didn't work instead of moving on silently.
      this.checkoutFailed.set(true);
      return false;
    }
    if (plan === 'team') {
      await this.router.navigate(['/teams'], { queryParams: { new: 1 } });
      return false;
    }
    await this.router.navigateByUrl(
      kind === 'email' ? '/verify-email?sent=1' : safeRedirect(this.redirect()),
    );
    return false;
  }
}
