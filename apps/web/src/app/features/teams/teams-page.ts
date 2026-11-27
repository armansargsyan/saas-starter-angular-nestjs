import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronRight, lucideUsers } from '@ng-icons/lucide';
import { PLANS } from '@saas-starter/shared';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSkeletonImports } from '@spartan-ng/helm/skeleton';
import { AuthService } from '../../core/auth.service';
import { ROLE_LABELS } from '../../core/team-roles';
import { TeamsApi } from '../../core/teams.api';
import { WorkspaceService } from '../../core/workspace.service';

@Component({
  selector: 'app-teams-page',
  imports: [
    RouterLink,
    NgIcon,
    HlmAlertImports,
    HlmBadgeImports,
    HlmButtonImports,
    HlmCardImports,
    HlmInputImports,
    HlmSkeletonImports,
  ],
  providers: [provideIcons({ lucideChevronRight, lucideUsers })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="grid gap-6">
      <h1 class="text-2xl font-semibold tracking-tight">Teams</h1>

      @if (workspaces.teamsResource.error()) {
        <div hlmCard class="text-center" role="alert" data-testid="load-error">
          <p hlmCardContent>
            Couldn’t load your teams.
            <button
              hlmBtn
              variant="link"
              type="button"
              (click)="workspaces.refreshTeams()"
            >
              Try again
            </button>
          </p>
        </div>
      } @else if (!workspaces.teamsResource.hasValue()) {
        <hlm-skeleton
          class="h-24 w-full"
          aria-hidden="true"
          data-testid="loading"
        />
      } @else if (workspaces.teams().length === 0) {
        <p class="text-muted-foreground" data-testid="empty">
          You’re not in a team yet. Create one to share links and analytics with
          others.
        </p>
      } @else {
        <ul
          role="list"
          class="grid gap-3 sm:grid-cols-2"
          data-testid="team-list"
        >
          @for (team of workspaces.teams(); track team.id) {
            <li>
              <a
                hlmCard
                [routerLink]="['/teams', team.id]"
                class="hover:bg-muted/50 flex-row items-center gap-4 px-6 transition-colors"
                [attr.data-team]="team.id"
              >
                <ng-icon
                  name="lucideUsers"
                  class="text-muted-foreground"
                  aria-hidden="true"
                />
                <div class="min-w-0 flex-1">
                  <p class="truncate font-medium">{{ team.name }}</p>
                  <p class="text-muted-foreground text-sm">
                    {{ team.memberCount }} member{{
                      team.memberCount === 1 ? '' : 's'
                    }}
                    · {{ planName(team.plan) }} plan
                  </p>
                </div>
                <span hlmBadge variant="secondary">{{
                  roleLabels[team.role]
                }}</span>
                <ng-icon name="lucideChevronRight" aria-hidden="true" />
              </a>
            </li>
          }
        </ul>
      }

      <section hlmCard aria-labelledby="create-team" class="max-w-xl">
        <div hlmCardHeader>
          <h2 hlmCardTitle id="create-team">Create a team</h2>
          <p hlmCardDescription>
            Teams share links and analytics. Inviting people needs the Team plan
            (\${{ teamPrice }}/month, up to {{ teamSeats }} members).
          </p>
        </div>
        <form
          hlmCardContent
          class="grid gap-2"
          (submit)="create($event)"
          novalidate
        >
          <label for="team-name" class="text-sm font-medium">Team name</label>
          <div class="flex gap-2">
            <input
              #nameInput
              hlmInput
              id="team-name"
              class="flex-1"
              maxlength="60"
              autocomplete="off"
              [value]="name()"
              (input)="onName($event)"
              [attr.aria-invalid]="error() ? 'true' : null"
              [attr.aria-describedby]="error() ? 'team-name-error' : null"
              data-testid="team-name"
            />
            @if (!readOnly()) {
              <button
                hlmBtn
                type="submit"
                [attr.aria-busy]="creating()"
                data-testid="create-team"
              >
                {{ creating() ? 'Creating…' : 'Create team' }}
              </button>
            }
          </div>
          @if (error()) {
            <p
              id="team-name-error"
              class="text-destructive text-sm"
              role="alert"
            >
              {{ error() }}
            </p>
          }
        </form>
      </section>
    </div>
  `,
})
export class TeamsPage implements OnInit {
  private readonly api = inject(TeamsApi);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly auth = inject(AuthService);
  protected readonly workspaces = inject(WorkspaceService);

  /** `?new=1`: from signing up for the Team plan; start with the form. */
  readonly new = input<string>();

  private readonly nameInput =
    viewChild<ElementRef<HTMLInputElement>>('nameInput');

  protected readonly roleLabels = ROLE_LABELS;
  protected readonly teamPrice = PLANS.team.priceMonthlyUsd;
  protected readonly teamSeats = PLANS.team.limits.members;
  protected readonly name = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly creating = signal(false);
  /** Impersonated sessions are read-only (the api enforces it too). */
  protected readonly readOnly = computed(
    () => this.auth.impersonatedBy() !== null,
  );

  ngOnInit(): void {
    if (this.new()) {
      afterNextRender(() => this.nameInput()?.nativeElement.focus(), {
        injector: this.injector,
      });
    }
  }

  protected planName(plan: keyof typeof PLANS): string {
    return PLANS[plan].name;
  }

  protected onName(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
    this.error.set(null);
  }

  protected async create(event: Event): Promise<void> {
    event.preventDefault();
    if (this.creating() || this.readOnly()) return;
    const name = this.name().trim();
    if (!name) {
      this.error.set('Enter a name for the team.');
      this.nameInput()?.nativeElement.focus();
      return;
    }
    this.creating.set(true);
    const result = await this.api.create(name);
    this.creating.set(false);
    if (!result.ok) {
      this.error.set(result.error.fields['name'] ?? result.error.message);
      this.nameInput()?.nativeElement.focus();
      return;
    }
    this.workspaces.refreshTeams();
    this.workspaces.select(result.value.id);
    await this.router.navigate(['/teams', result.value.id]);
  }
}
