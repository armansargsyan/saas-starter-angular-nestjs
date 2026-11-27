import { DatePipe } from '@angular/common';
import { HttpErrorResponse, httpResource } from '@angular/common/http';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DOCUMENT,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft, lucideCopy, lucideX } from '@ng-icons/lucide';
import {
  type AssignableRole,
  can,
  PLANS,
  type Team,
  type TeamInvite,
  type TeamInviteListResponse,
  type TeamMember,
  type TeamMemberListResponse,
} from '@saas-starter/shared';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmAlertDialogImports } from '@spartan-ng/helm/alert-dialog';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmInputImports } from '@spartan-ng/helm/input';
import {
  type HlmNativeSelect,
  HlmNativeSelectImports,
} from '@spartan-ng/helm/native-select';
import { HlmSkeletonImports } from '@spartan-ng/helm/skeleton';
import { AuthService } from '../../core/auth.service';
import { ROLE_LABELS } from '../../core/team-roles';
import { TeamsApi } from '../../core/teams.api';
import { WorkspaceService } from '../../core/workspace.service';

/** A link just created for someone: shown once (only its hash is stored). */
interface SharedLink {
  email: string;
  url: string;
}

@Component({
  selector: 'app-team-page',
  imports: [
    DatePipe,
    RouterLink,
    NgIcon,
    HlmAlertImports,
    HlmAlertDialogImports,
    HlmBadgeImports,
    HlmButtonImports,
    HlmCardImports,
    HlmInputImports,
    HlmNativeSelectImports,
    HlmSkeletonImports,
  ],
  providers: [provideIcons({ lucideArrowLeft, lucideCopy, lucideX })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './team-page.html',
})
export class TeamPage {
  private readonly api = inject(TeamsApi);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly view = inject(DOCUMENT).defaultView;
  protected readonly workspaces = inject(WorkspaceService);

  readonly teamId = input.required<string>();

  protected readonly team = httpResource<Team>(
    () => `/api/teams/${encodeURIComponent(this.teamId())}`,
  );
  protected readonly members = httpResource<TeamMemberListResponse>(
    () => `/api/teams/${encodeURIComponent(this.teamId())}/members`,
  );
  /** Only people who can invite see invites (the api answers 403 otherwise). */
  protected readonly invites = httpResource<TeamInviteListResponse>(() =>
    this.can('inviteMembers')
      ? `/api/teams/${encodeURIComponent(this.teamId())}/invites`
      : undefined,
  );

  /** `value()` throws while a resource is in an error state: read through these. */
  protected readonly teamValue = computed(() =>
    this.team.hasValue() ? this.team.value() : undefined,
  );
  protected readonly memberList = computed<TeamMember[]>(() =>
    this.members.hasValue() ? this.members.value().items : [],
  );
  protected readonly pendingInvites = computed(() => {
    const now = Date.now();
    return (this.invites.hasValue() ? this.invites.value().items : [])
      .filter((invite) => invite.status === 'pending')
      .map((invite) => ({
        ...invite,
        expired: new Date(invite.expiresAt).getTime() <= now,
      }));
  });
  protected readonly notFound = computed(() => {
    const err = this.team.error();
    return err instanceof HttpErrorResponse && err.status === 404;
  });

  protected readonly me = computed(() => this.auth.user()?.uid ?? null);
  protected readonly myRole = computed(() => this.teamValue()?.role ?? null);
  /** Impersonated sessions are read-only (the api enforces it too). */
  protected readonly readOnly = computed(
    () => this.auth.impersonatedBy() !== null,
  );
  protected readonly roleLabels = ROLE_LABELS;
  protected readonly teamPlan = PLANS.team;

  protected readonly plan = computed(
    () => PLANS[this.teamValue()?.plan ?? 'free'],
  );
  protected readonly seatLimit = computed(() => this.plan().limits.members);
  protected readonly seatsFull = computed(() => {
    const limit = this.seatLimit();
    const team = this.teamValue();
    return !!team && limit !== null && team.memberCount >= limit;
  });
  protected readonly isCurrent = computed(
    () => this.workspaces.workspaceId() === this.teamId(),
  );

  protected readonly renaming = signal(false);
  protected readonly newName = signal('');
  protected readonly inviteEmail = signal('');
  protected readonly inviteRole = signal<AssignableRole>('member');
  protected readonly inviteError = signal<string | null>(null);
  protected readonly link = signal<SharedLink | null>(null);
  protected readonly busy = signal<string | null>(null);
  /** Visible failures, dismissible. */
  protected readonly notice = signal<string | null>(null);
  /** Screen-reader announcements (successes). */
  protected readonly announcement = signal('');

  protected can(permission: Parameters<typeof can>[1]): boolean {
    return !this.readOnly() && can(this.myRole(), permission);
  }

  /** Owners and admins remove members; admins only members; nobody the owner. */
  protected canRemove(member: TeamMember): boolean {
    const role = this.myRole();
    return (
      member.uid !== this.me() &&
      member.role !== 'owner' &&
      this.can('removeMembers') &&
      (role === 'owner' || member.role === 'member')
    );
  }

  protected canLeave(member: TeamMember): boolean {
    return (
      member.uid === this.me() && member.role !== 'owner' && !this.readOnly()
    );
  }

  protected canChangeRole(member: TeamMember): boolean {
    return member.role !== 'owner' && this.can('changeRoles');
  }

  protected use(): void {
    this.workspaces.select(this.teamId());
    void this.router.navigateByUrl('/dashboard');
  }

  /** Billing is per workspace: switch to the team first. */
  protected upgrade(): void {
    this.workspaces.select(this.teamId());
    void this.router.navigateByUrl('/billing');
  }

  protected startRename(): void {
    this.newName.set(this.teamValue()?.name ?? '');
    this.renaming.set(true);
    this.focus('#team-rename');
  }

  protected async rename(event: Event): Promise<void> {
    event.preventDefault();
    const name = this.newName().trim();
    if (!name || this.busy()) return;
    this.busy.set('rename');
    const result = await this.api.rename(this.teamId(), name);
    this.busy.set(null);
    if (!result.ok) {
      this.notice.set(result.error.fields['name'] ?? result.error.message);
      return;
    }
    this.renaming.set(false);
    this.team.set(result.value);
    this.workspaces.refreshTeams();
    this.announcement.set(`Renamed to ${result.value.name}.`);
  }

  /**
   * The select shows what was picked right away; whenever the change doesn't
   * go through, put it back to the member's actual role.
   */
  protected async setRole(
    member: TeamMember,
    event: string | null | undefined,
    select: HlmNativeSelect,
  ): Promise<void> {
    const revert = () => select.value.set(member.role);
    if (event !== 'admin' && event !== 'member') return revert();
    if (event === member.role) return;
    if (this.busy()) return revert();
    this.busy.set(member.uid);
    const result = await this.api.setRole(this.teamId(), member.uid, event);
    this.busy.set(null);
    if (result.ok) {
      this.announcement.set(
        `${member.email ?? 'Member'} is now ${ROLE_LABELS[event]}.`,
      );
    } else {
      revert();
      this.notice.set(`Couldn’t change the role: ${result.error.message}`);
    }
    this.members.reload();
  }

  protected async remove(member: TeamMember, close: () => void): Promise<void> {
    if (this.busy()) return;
    const leaving = member.uid === this.me();
    this.busy.set(member.uid);
    const result = await this.api.removeMember(this.teamId(), member.uid);
    this.busy.set(null);
    close();
    if (!result.ok) {
      this.notice.set(
        `Couldn’t ${leaving ? 'leave the team' : 'remove ' + (member.email ?? 'the member')}: ${result.error.message}`,
      );
      return;
    }
    this.workspaces.refreshTeams();
    if (leaving) {
      if (this.isCurrent()) this.workspaces.select(null);
      await this.router.navigateByUrl('/teams');
      return;
    }
    this.announcement.set(`Removed ${member.email ?? 'the member'}.`);
    this.members.reload();
    this.team.reload(); // the seat count
    this.focus('#invite-email, h1');
  }

  protected async sendInvite(event: Event): Promise<void> {
    event.preventDefault();
    const email = this.inviteEmail().trim();
    if (!email) {
      this.inviteError.set('Enter an email address.');
      this.focus('#invite-email');
      return;
    }
    const ok = await this.invite(email, this.inviteRole());
    if (ok) {
      this.inviteEmail.set('');
      this.inviteRole.set('member');
    } else {
      this.focus('#invite-email');
    }
  }

  /** A new link replaces the old one (the api revokes the pending invite). */
  protected resend(invite: TeamInvite): Promise<boolean> {
    return this.invite(invite.email, invite.role);
  }

  protected async revoke(invite: TeamInvite): Promise<void> {
    if (this.busy()) return;
    this.busy.set(invite.id);
    const result = await this.api.revokeInvite(this.teamId(), invite.id);
    this.busy.set(null);
    if (result.ok) {
      if (this.link()?.email === invite.email) this.link.set(null);
      this.announcement.set(`Revoked the invite for ${invite.email}.`);
    } else {
      this.notice.set(`Couldn’t revoke the invite: ${result.error.message}`);
    }
    this.invites.reload();
  }

  protected async copyLink(): Promise<void> {
    const link = this.link();
    if (!link) return;
    try {
      const clipboard = this.view?.navigator.clipboard;
      if (!clipboard) throw new Error('no clipboard');
      await clipboard.writeText(link.url);
      this.announcement.set('Invite link copied.');
    } catch {
      this.notice.set('Couldn’t copy. Select the link and copy it manually.');
    }
  }

  protected onInput(target: 'email' | 'name', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    if (target === 'email') {
      this.inviteEmail.set(value);
      this.inviteError.set(null);
    } else {
      this.newName.set(value);
    }
  }

  protected onInviteRole(value: string | null | undefined): void {
    this.inviteRole.set(value === 'admin' ? 'admin' : 'member');
  }

  private async invite(email: string, role: AssignableRole): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(`invite:${email}`);
    this.inviteError.set(null);
    const result = await this.api.invite(this.teamId(), email, role);
    this.busy.set(null);
    if (!result.ok) {
      this.inviteError.set(
        result.error.fields['email'] ?? result.error.message,
      );
      return false;
    }
    this.link.set({
      email: result.value.invite.email,
      url: result.value.acceptUrl,
    });
    this.announcement.set(
      `Invite link for ${result.value.invite.email} is ready to share.`,
    );
    this.invites.reload();
    this.focus('#invite-link');
    return true;
  }

  private focus(selector: string): void {
    afterNextRender(
      () =>
        this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(),
      { injector: this.injector },
    );
  }
}
