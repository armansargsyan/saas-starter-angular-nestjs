import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AssignableRole,
  CreateInviteResponse,
  InvitePreview,
  Team,
} from '@saas-starter/shared';
import { apiResult, type ApiResult } from './api-result';

/** Team mutations and invite actions (reads use httpResource in the pages). */
@Injectable({ providedIn: 'root' })
export class TeamsApi {
  private readonly http = inject(HttpClient);

  create(name: string): Promise<ApiResult<Team>> {
    return apiResult(this.http.post<Team>('/api/teams', { name }));
  }

  rename(teamId: string, name: string): Promise<ApiResult<Team>> {
    return apiResult(this.http.patch<Team>(team(teamId), { name }));
  }

  setRole(
    teamId: string,
    uid: string,
    role: AssignableRole,
  ): Promise<ApiResult<unknown>> {
    return apiResult(this.http.patch(member(teamId, uid), { role }));
  }

  /** Removes a member, or leaves the team when `uid` is the caller's. */
  removeMember(teamId: string, uid: string): Promise<ApiResult<unknown>> {
    return apiResult(this.http.delete(member(teamId, uid)));
  }

  /** Inviting an address again replaces its pending invite (a "resend"). */
  invite(
    teamId: string,
    email: string,
    role: AssignableRole,
  ): Promise<ApiResult<CreateInviteResponse>> {
    return apiResult(
      this.http.post<CreateInviteResponse>(`${team(teamId)}/invites`, {
        email,
        role,
      }),
    );
  }

  revokeInvite(teamId: string, inviteId: string): Promise<ApiResult<unknown>> {
    return apiResult(
      this.http.delete(
        `${team(teamId)}/invites/${encodeURIComponent(inviteId)}`,
      ),
    );
  }

  /** The token goes in the body, never in a URL. */
  previewInvite(token: string): Promise<ApiResult<InvitePreview>> {
    return apiResult(
      this.http.post<InvitePreview>('/api/invites/preview', { token }),
    );
  }

  acceptInvite(token: string): Promise<ApiResult<Team>> {
    return apiResult(this.http.post<Team>('/api/invites/accept', { token }));
  }

  declineInvite(token: string): Promise<ApiResult<unknown>> {
    return apiResult(this.http.post('/api/invites/decline', { token }));
  }
}

const team = (teamId: string) => `/api/teams/${encodeURIComponent(teamId)}`;
const member = (teamId: string, uid: string) =>
  `${team(teamId)}/members/${encodeURIComponent(uid)}`;
