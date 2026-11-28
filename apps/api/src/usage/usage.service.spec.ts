import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import type { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import type {
  WorkspaceUsageSnapshot,
  WorkspacesRepository,
} from '../workspaces/workspaces.repository';
import { UsageService } from './usage.service';

const user: AuthUser = {
  uid: 'alice',
  email: null,
  emailVerified: true,
  role: 'user',
  tokenIssuedAt: new Date(0),
  authTime: new Date(0),
};

function service(snapshot: WorkspaceUsageSnapshot | null, allowed = true) {
  const access = {
    assertAccess: vi.fn(async () => {
      if (!allowed) throw new NotFoundException();
    }),
  };
  const workspaces = { getUsage: vi.fn().mockResolvedValue(snapshot) };
  return new UsageService(
    access as unknown as WorkspaceAccessService,
    workspaces as unknown as WorkspacesRepository,
  );
}

const plan = (
  id: 'pro' | 'team',
  status: 'active' | 'canceled' | 'past_due',
) => ({
  id,
  status,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
});

describe('UsageService', () => {
  it('reports Free and empty usage before the workspace exists', async () => {
    expect(await service(null).get(user, 'alice')).toEqual({
      workspaceId: 'alice',
      plan: 'free',
      links: { used: 0, limit: 10 },
      members: { used: 1, limit: 1 },
    });
  });

  it('reports counts against the effective plan', async () => {
    const usage = await service({
      plan: plan('pro', 'past_due'),
      linkCount: 42,
      memberCount: 1,
    }).get(user, 'alice');
    expect(usage).toMatchObject({
      plan: 'pro',
      links: { used: 42, limit: null },
    });
  });

  it('falls back to Free limits after cancellation, keeping the real count', async () => {
    const usage = await service({
      plan: plan('pro', 'canceled'),
      linkCount: 15,
      memberCount: 1,
    }).get(user, 'alice');
    expect(usage).toMatchObject({
      plan: 'free',
      links: { used: 15, limit: 10 },
    });
  });

  it('reports team seats', async () => {
    const usage = await service({
      plan: plan('team', 'active'),
      linkCount: 3,
      memberCount: 4,
    }).get(user, 'team-1');
    expect(usage.members).toEqual({ used: 4, limit: 10 });
  });

  it('does not invent a member for a team doc without memberCount', async () => {
    const usage = await service({
      plan: plan('team', 'active'),
      linkCount: 0,
      memberCount: null,
    }).get(user, 'team-1');
    expect(usage.members.used).toBe(0);
  });

  it("refuses workspaces the caller can't access", async () => {
    await expect(service(null, false).get(user, 'bob')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
