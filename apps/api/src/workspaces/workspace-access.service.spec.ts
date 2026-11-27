import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import { WorkspaceAccessService } from './workspace-access.service';
import type { WorkspacesRepository } from './workspaces.repository';

const user: AuthUser = {
  uid: 'alice',
  email: null,
  emailVerified: true,
  role: 'user',
  tokenIssuedAt: new Date(0),
};

function service(isMember: boolean) {
  const repo = {
    getPlan: vi.fn(),
    isMember: vi.fn().mockResolvedValue(isMember),
  };
  return {
    repo,
    access: new WorkspaceAccessService(repo as unknown as WorkspacesRepository),
  };
}

describe('WorkspaceAccessService', () => {
  it('grants the personal workspace without a lookup', async () => {
    const { access, repo } = service(false);
    expect(await access.canAccess(user, 'alice')).toBe(true);
    expect(repo.isMember).not.toHaveBeenCalled();
  });

  it('checks membership for any other workspace', async () => {
    const { access, repo } = service(true);
    expect(await access.canAccess(user, 'team-1')).toBe(true);
    expect(repo.isMember).toHaveBeenCalledWith('team-1', 'alice');
  });

  it("throws 404 for a workspace the user isn't in", async () => {
    const { access } = service(false);
    await expect(access.assertAccess(user, 'bob')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('does not treat admins specially', async () => {
    const { access } = service(false);
    expect(await access.canAccess({ ...user, role: 'admin' }, 'bob')).toBe(
      false,
    );
  });
});
