import { httpResource } from '@angular/common/http';
import {
  computed,
  DOCUMENT,
  inject,
  Injectable,
  linkedSignal,
} from '@angular/core';
import type { Team, TeamListResponse } from '@saas-starter/shared';
import { AuthService } from './auth.service';

const KEY = 'saas-starter.workspace';

/**
 * The workspace the signed-in pages work in: the personal one (id = uid) or
 * a team the user belongs to. The choice is remembered per user on this
 * device; the api checks membership on every request regardless.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceService {
  private readonly auth = inject(AuthService);
  private readonly storage = inject(DOCUMENT).defaultView?.localStorage;

  private readonly uid = computed(() => this.auth.user()?.uid ?? null);

  /** Teams the user is in (for the switcher and the Teams page). */
  readonly teamsResource = httpResource<TeamListResponse>(() =>
    this.uid() ? '/api/teams' : undefined,
  );
  readonly teams = computed<Team[]>(() =>
    this.teamsResource.hasValue() ? this.teamsResource.value().items : [],
  );

  /** The stored choice; starts over for each signed-in user. */
  private readonly chosen = linkedSignal<string | null, string | null>({
    source: this.uid,
    computation: (uid) => (uid ? this.read(uid) : null),
  });

  readonly workspaceId = computed(() => {
    const uid = this.uid();
    const chosen = this.chosen();
    if (!uid || !chosen || chosen === uid) return uid;
    const status = this.teamsResource.status();
    // Can't confirm the team: personal is always yours.
    if (status === 'error') return uid;
    // A stored team waits for the list (pages show their loading state).
    if (!this.teamsResource.hasValue()) return null;
    // Once the list is known (not mid-reload, e.g. right after joining), a
    // team the user has left falls back to personal.
    if (
      status === 'resolved' &&
      !this.teams().some((team) => team.id === chosen)
    ) {
      return uid;
    }
    return chosen;
  });
  readonly isPersonal = computed(
    () => !!this.uid() && this.workspaceId() === this.uid(),
  );
  /** The selected team, or null in the personal workspace. */
  readonly currentTeam = computed(
    () => this.teams().find((team) => team.id === this.workspaceId()) ?? null,
  );

  /** Switches to a team (by id) or to the personal workspace (null or uid). */
  select(workspaceId: string | null): void {
    const uid = this.uid();
    if (!uid) return;
    const next = workspaceId ?? uid;
    this.chosen.set(next);
    try {
      this.storage?.setItem(`${KEY}:${uid}`, next);
    } catch {
      // storage blocked: the choice lasts for this page view
    }
  }

  /** After creating, joining or leaving a team. */
  refreshTeams(): void {
    this.teamsResource.reload();
  }

  private read(uid: string): string | null {
    try {
      return this.storage?.getItem(`${KEY}:${uid}`) ?? null;
    } catch {
      return null;
    }
  }
}
