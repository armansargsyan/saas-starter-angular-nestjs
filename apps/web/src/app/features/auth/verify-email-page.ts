import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  OnInit,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { authErrorMessage } from '../../core/auth-errors';
import { AuthService } from '../../core/auth.service';
import { PendingInvite } from '../../core/pending-invite';
import { AuthCard } from './auth-card';

/** Seconds before "Resend" works again (Firebase also rate limits). */
export const RESEND_COOLDOWN_S = 30;

/**
 * Where password accounts verify their email. The emailed link also comes
 * back here, so arriving re-checks the account (and refreshes the token the
 * api reads) and moves on once verified.
 */
@Component({
  selector: 'app-verify-email-page',
  imports: [RouterLink, HlmAlertImports, HlmButtonImports, AuthCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-auth-card
      heading="Verify your email"
      description="One more step to secure your account."
    >
      <p class="text-sm">
        @if (sent()) {
          We sent a verification link to
          <strong>{{ auth.user()?.email }}</strong>. Open it, then come back
          here.
        } @else {
          Verify <strong>{{ auth.user()?.email }}</strong> by opening the link
          we emailed you. Need a new one? Send it again below.
        }
      </p>
      @if (invitePending) {
        <p class="text-muted-foreground mt-2 text-sm" data-testid="invite-hint">
          Your team invite is waiting in this tab: after opening the link in the
          email, come back here.
        </p>
      }
      <div role="status" class="mt-4 min-h-5 text-sm" data-testid="status">
        {{ status() }}
      </div>
      <div class="mt-4 grid gap-2">
        <button
          hlmBtn
          type="button"
          class="w-full aria-disabled:opacity-60"
          [attr.aria-disabled]="checking() ? 'true' : null"
          [attr.aria-busy]="checking()"
          (click)="check()"
          data-testid="check"
        >
          {{ checking() ? 'Checking…' : 'I’ve verified my email' }}
        </button>
        <button
          hlmBtn
          variant="outline"
          type="button"
          class="w-full aria-disabled:opacity-60"
          [attr.aria-disabled]="sending() || cooldown() > 0 ? 'true' : null"
          [attr.aria-busy]="sending()"
          (click)="resend()"
          data-testid="resend"
        >
          @if (sending()) {
            Sending…
          } @else if (cooldown() > 0) {
            Resend in {{ cooldown() }}s
          } @else {
            Resend the email
          }
        </button>
      </div>
      <p authFooter>
        <a
          routerLink="/dashboard"
          class="text-foreground font-medium underline-offset-4 hover:underline"
          >Continue to the dashboard</a
        >
        and verify later.
      </p>
    </app-auth-card>
  `,
})
export class VerifyEmailPage implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly pendingInvite = inject(PendingInvite);
  protected readonly invitePending = this.pendingInvite.get() !== null;

  /** `?sent=1` right after sign-up: the email went out a moment ago. */
  readonly sent = input(false, {
    transform: (value: unknown) => value === '1' || value === true,
  });

  protected readonly status = signal('');
  protected readonly checking = signal(false);
  protected readonly sending = signal(false);
  protected readonly cooldown = signal(0);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopTimer());
  }

  ngOnInit(): void {
    if (this.sent()) this.startCooldown();
    // Arrival check is silent: the buttons report errors when used.
    void this.refresh().catch(() => undefined);
  }

  protected async check(): Promise<void> {
    if (this.checking()) return;
    this.checking.set(true);
    try {
      if (!(await this.refresh())) {
        this.status.set(
          'Not verified yet. Open the link in the email, then try again.',
        );
      }
    } catch (err) {
      this.status.set(authErrorMessage(err) ?? '');
    } finally {
      this.checking.set(false);
    }
  }

  protected async resend(): Promise<void> {
    if (this.sending() || this.cooldown() > 0) return;
    this.sending.set(true);
    try {
      await this.auth.resendVerification();
      this.status.set('Sent. Check your inbox (and spam folder).');
      this.startCooldown();
    } catch (err) {
      this.status.set(authErrorMessage(err) ?? '');
    } finally {
      this.sending.set(false);
    }
  }

  /** Re-reads the account; moves on when verified. */
  private async refresh(): Promise<boolean> {
    const user = await this.auth.reloadUser();
    if (user?.emailVerified) {
      // Verifying on the way to an invite: go back to it.
      await this.router.navigateByUrl(
        this.pendingInvite.get() ? '/invite' : '/dashboard',
      );
      return true;
    }
    return false;
  }

  private startCooldown(): void {
    this.stopTimer();
    this.cooldown.set(RESEND_COOLDOWN_S);
    this.timer = setInterval(() => {
      this.cooldown.update((s) => Math.max(0, s - 1));
      if (this.cooldown() === 0) this.stopTimer();
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
