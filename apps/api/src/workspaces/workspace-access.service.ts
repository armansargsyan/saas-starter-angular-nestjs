import { Injectable, NotFoundException } from '@nestjs/common';
import type { TeamRole } from '@saas-starter/shared';
import type { AuthUser } from '../auth/auth-user';
import { WorkspacesRepository } from './workspaces.repository';

/**
 * Who may touch a workspace's data: its owner (a personal workspace's id is
 * the owner's uid) or a member of a team workspace. Never trust a workspace
 * id from the client without this check.
 */
@Injectable()
export class WorkspaceAccessService {
  constructor(private readonly workspaces: WorkspacesRepository) {}

  async canAccess(user: AuthUser, workspaceId: string): Promise<boolean> {
    if (workspaceId === user.uid) return true;
    return this.workspaces.isMember(workspaceId, user.uid);
  }

  /** The caller's role: `owner` of their personal workspace, else their team role. */
  async getRole(user: AuthUser, workspaceId: string): Promise<TeamRole | null> {
    if (workspaceId === user.uid) return 'owner';
    return this.workspaces.getMemberRole(workspaceId, user.uid);
  }

  /** 404, not 403: don't reveal that someone else's workspace exists. */
  async assertAccess(user: AuthUser, workspaceId: string): Promise<void> {
    if (!(await this.canAccess(user, workspaceId))) {
      throw new NotFoundException('Workspace not found');
    }
  }
}
