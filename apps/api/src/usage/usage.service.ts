import { Injectable } from '@nestjs/common';
import {
  effectivePlanId,
  PLANS,
  type UsageResponse,
} from '@saas-starter/shared';
import type { AuthUser } from '../auth/auth-user';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { WorkspacesRepository } from '../workspaces/workspaces.repository';

@Injectable()
export class UsageService {
  constructor(
    private readonly access: WorkspaceAccessService,
    private readonly workspaces: WorkspacesRepository,
  ) {}

  /** Usage and limits of a workspace, computed from the server-side record. */
  async get(user: AuthUser, workspaceId: string): Promise<UsageResponse> {
    await this.access.assertAccess(user, workspaceId);
    // A personal workspace has no doc until its first link: Free, empty.
    const usage = await this.workspaces.getUsage(workspaceId);
    const plan = effectivePlanId(usage?.plan);
    const { limits } = PLANS[plan];

    return {
      workspaceId,
      plan,
      links: { used: usage?.linkCount ?? 0, limit: limits.links },
      members: {
        used:
          usage?.memberCount ?? (this.isPersonal(user, workspaceId) ? 1 : 0),
        limit: limits.members,
      },
    };
  }

  /** A personal workspace has exactly one member, its owner (id = uid). */
  private isPersonal(user: AuthUser, workspaceId: string): boolean {
    return workspaceId === user.uid;
  }
}
