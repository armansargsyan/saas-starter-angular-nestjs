import { Location } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DOCUMENT,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { InvitePreview } from '@saas-starter/shared';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSkeletonImports } from '@spartan-ng/helm/skeleton';
import type { ApiError } from '../../core/api-result';
import { AuthService } from '../../core/auth.service';
import { PendingInvite } from '../../core/pending-invite';
import { ROLE_LABELS } from '../../core/team-roles';
import { TeamsApi } from '../../core/teams.api';
import { WorkspaceService } from '../../core/workspace.service';
import { AuthCard } from '../auth/auth-card';

type View =
  'loading' | 'no-token' | 'signed-out' | 'ready' | 'failed' | 'declined';

/** Errors that mean this invite is done for: forget the token. */
const FINAL = new Set(['invite_invalid', 'invite_expired', 'already_member']);

/**
 * `/invite#token=…`: the link from an invite. The token rides in the
 * fragment (never sent to servers) and is kept in session storage while the
 * invitee signs in, signs up or verifies their email.
 */
@Component({
  selector: 'app-invite-page',
  imports: [
    RouterLink,
    HlmAlertImports,
    HlmButtonImports,
    HlmSkeletonImports,
    AuthCard,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-auth-card [heading]="heading()" [description]="description()">
      <div role="status" class="sr-only">{{ statusText() }}</div>
      @switch (view()) {
        @case ('loading') {
          <hlm-skeleton
            class="h-20 w-full"
            aria-hidden="true"
            data-testid="loading"
          />
        }
        @case ('no-token') {
          <p class="text-muted-foreground text-sm" data-testid="no-token">
            This link is incomplete. Open the invite link exactly as you
            received it, or ask for a new one.
          </p>
        }
        @case ('signed-out') {
          <div class="grid gap-3" data-testid="signed-out">
            <p class="text-muted-foreground text-sm">
              Sign in, or create an account with the email address the invite
              was sent to.
            </p>
            <a
              hlmBtn
              routerLink="/login"
              [queryParams]="{ redirect: '/invite' }"
              >Sign in</a
            >
            <a
              hlmBtn
              variant="outline"
              routerLink="/signup"
              [queryParams]="{ redirect: '/invite' }"
              >Create an account</a
            >
          </div>
        }
        @case ('ready') {
          @if (preview(); as p) {
            <div class="grid gap-4" data-testid="ready">
              @if (wrongAccount()) {
                <div hlmAlert variant="destructive" data-testid="wrong-account">
                  <p hlmAlertTitle>This invite is for {{ p.email }}</p>
                  <p hlmAlertDescription>
                    You’re signed in as {{ auth.user()?.email }}. Sign in with
                    the invited address to accept it.
                  </p>
                </div>
                <button
                  hlmBtn
                  variant="outline"
                  type="button"
                  (click)="switchAccount()"
                >
                  Sign in with another account
                </button>
              } @else if (!auth.user()?.emailVerified) {
                <div hlmAlert data-testid="unverified">
                  <p hlmAlertTitle>Verify your email first</p>
                  <p hlmAlertDescription>
                    Only a verified address proves the invite reached you.
                    You’ll come back here afterwards.
                  </p>
                </div>
                <a hlmBtn routerLink="/verify-email">Verify my email</a>
              } @else {
                <div role="alert">
                  @if (error()) {
                    <div hlmAlert variant="destructive" data-testid="error">
                      <p hlmAlertDescription>{{ error()?.message }}</p>
                    </div>
                  }
                </div>
                <div class="flex flex-wrap gap-2">
                  <button
                    hlmBtn
                    type="button"
                    class="flex-1"
                    [attr.aria-busy]="busy() === 'accept'"
                    (click)="accept()"
                    data-testid="accept"
                  >
                    {{
                      busy() === 'accept' ? 'Joining…' : 'Join ' + p.teamName
                    }}
                  </button>
                  <button
                    hlmBtn
                    variant="outline"
                    type="button"
                    [attr.aria-busy]="busy() === 'decline'"
                    (click)="decline()"
                    data-testid="decline"
                  >
                    Decline
                  </button>
                </div>
              }
            </div>
          }
        }
        @case ('failed') {
          <div class="grid gap-3" data-testid="failed">
            <div hlmAlert variant="destructive">
              <p hlmAlertDescription>{{ error()?.message }}</p>
            </div>
            @if (error()?.code === 'already_member') {
              <a hlmBtn routerLink="/teams">Go to your teams</a>
            } @else if (canRetry()) {
              <button hlmBtn variant="outline" type="button" (click)="load()">
                Try again
              </button>
            }
          </div>
        }
        @case ('declined') {
          <p class="text-muted-foreground text-sm" data-testid="declined">
            You declined the invite. Nothing changed in your account.
          </p>
        }
      }
      <p authFooter>
        <a
          [routerLink]="auth.signedIn() ? '/dashboard' : '/'"
          class="text-foreground font-medium underline-offset-4 hover:underline"
          >{{
            auth.signedIn() ? 'Go to your links' : 'Back to the home page'
          }}</a
        >
      </p>
    </app-auth-card>
  `,
})
export class InvitePage implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(TeamsApi);
  private readonly pending = inject(PendingInvite);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly document = inject(DOCUMENT);
  private readonly workspaces = inject(WorkspaceService);

  protected readonly view = signal<View>('loading');
  protected readonly preview = signal<InvitePreview | null>(null);
  protected readonly error = signal<ApiError | null>(null);
  protected readonly busy = signal<'accept' | 'decline' | null>(null);
  private token: string | null = null;

  protected readonly heading = computed(() => {
    const p = this.preview();
    return this.view() === 'ready' && p
      ? `Join ${p.teamName}`
      : 'You’re invited to a team';
  });
  protected readonly description = computed(() => {
    const p = this.preview();
    return this.view() === 'ready' && p
      ? `You’ve been invited as ${ROLE_LABELS[p.role].toLowerCase()}. The invite expires ${new Date(p.expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}.`
      : '';
  });
  protected readonly wrongAccount = computed(() => {
    const invited = this.preview()?.email.toLowerCase();
    const mine = this.auth.user()?.email?.toLowerCase();
    return !!invited && !!mine && invited !== mine;
  });
  /** Anything but a final answer (network, rate limit, server) may work next time. */
  protected readonly canRetry = computed(() => {
    const error = this.error();
    return !!error && !FINAL.has(error.code);
  });
  protected readonly statusText = computed(() =>
    this.view() === 'declined' ? 'Invite declined.' : '',
  );

  async ngOnInit(): Promise<void> {
    const fromLink = /(?:^#|&)token=([^&]+)/.exec(this.document.location.hash);
    if (fromLink) {
      try {
        this.token = decodeURIComponent(fromLink[1]);
        this.pending.set(this.token);
      } catch {
        this.token = null; // a mangled link: say it's incomplete
      }
      // Keep the secret out of the address bar and history.
      this.location.replaceState('/invite');
    } else {
      this.token = this.pending.get();
    }
    await this.load();
  }

  protected async load(): Promise<void> {
    if (!this.token) {
      this.view.set('no-token');
      return;
    }
    this.view.set('loading');
    await this.auth.whenReady();
    if (!this.auth.signedIn()) {
      this.view.set('signed-out');
      return;
    }
    const result = await this.api.previewInvite(this.token);
    if (result.ok) {
      this.preview.set(result.value);
      this.view.set('ready');
    } else {
      this.fail(result.error);
    }
  }

  protected async accept(): Promise<void> {
    if (!this.token || this.busy()) return;
    this.busy.set('accept');
    this.error.set(null);
    const result = await this.api.acceptInvite(this.token);
    this.busy.set(null);
    if (!result.ok) {
      if (FINAL.has(result.error.code)) this.fail(result.error);
      else this.error.set(result.error);
      return;
    }
    this.pending.clear();
    this.workspaces.refreshTeams();
    this.workspaces.select(result.value.id);
    await this.router.navigate(['/teams', result.value.id]);
  }

  protected async decline(): Promise<void> {
    if (!this.token || this.busy()) return;
    this.busy.set('decline');
    this.error.set(null);
    const result = await this.api.declineInvite(this.token);
    this.busy.set(null);
    if (!result.ok) {
      if (FINAL.has(result.error.code)) this.fail(result.error);
      else this.error.set(result.error);
      return;
    }
    this.pending.clear();
    this.view.set('declined');
  }

  /** Signs out but keeps the invite, so the right account can pick it up. */
  protected async switchAccount(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigate(['/login'], {
      queryParams: { redirect: '/invite' },
    });
  }

  private fail(error: ApiError): void {
    if (FINAL.has(error.code)) this.pending.clear();
    this.error.set(error);
    this.view.set('failed');
  }
}
