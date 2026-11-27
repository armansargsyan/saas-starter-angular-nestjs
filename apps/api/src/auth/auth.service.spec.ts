import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger, UnauthorizedException } from '@nestjs/common';
import type { IdentityProvider } from '../firebase/identity.provider';
import type { WorkspacesRepository } from '../workspaces/workspaces.repository';
import type { AuthUser } from './auth-user';
import { AuthService } from './auth.service';
import type { UserProfile, UsersRepository } from './users.repository';

const stored: UserProfile = {
  uid: 'u1',
  email: 'a@example.com',
  displayName: 'Ada',
  photoURL: null,
  role: 'user',
  status: 'active',
  roleChangedAt: null,
};

describe('AuthService.me', () => {
  const identity = { verifyIdToken: vi.fn(), getUser: vi.fn() };
  const users = { get: vi.fn(), createIfAbsent: vi.fn(), setRole: vi.fn() };
  const caller = (overrides: Partial<AuthUser> = {}): AuthUser => ({
    uid: 'u1',
    email: null,
    emailVerified: false,
    role: 'user',
    tokenIssuedAt: new Date('2026-06-01T12:00:00Z'),
    ...overrides,
  });
  const workspaces = { getPlan: vi.fn() };
  let service: AuthService;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    workspaces.getPlan.mockResolvedValue(null);
    service = new AuthService(
      identity as unknown as IdentityProvider,
      users as unknown as UsersRepository,
      workspaces as unknown as WorkspacesRepository,
    );
  });

  it('returns the stored profile with the free plan by default', async () => {
    users.get.mockResolvedValue(stored);

    const me = await service.me(caller());

    expect(me).toEqual({
      uid: 'u1',
      email: 'a@example.com',
      displayName: 'Ada',
      photoURL: null,
      role: 'user',
      plan: 'free',
    });
    expect(identity.getUser).not.toHaveBeenCalled();
    expect(users.createIfAbsent).not.toHaveBeenCalled();
    expect(users.setRole).not.toHaveBeenCalled();
  });

  it("prefers the token's email over the stored one", async () => {
    users.get.mockResolvedValue(stored);

    const me = await service.me(caller({ email: 'new@example.com' }));

    expect(me.email).toBe('new@example.com');
  });

  it('returns 401 when the account was deleted before first sign-in', async () => {
    users.get.mockResolvedValue(null);
    identity.getUser.mockResolvedValue(null);

    await expect(service.me(caller())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(users.createIfAbsent).not.toHaveBeenCalled();
  });

  it('creates the profile on first sign-in from the identity record', async () => {
    users.get.mockResolvedValue(null);
    identity.getUser.mockResolvedValue({
      uid: 'u1',
      email: 'a@example.com',
      displayName: 'Ada',
      photoURL: 'https://example.com/a.png',
    });
    users.createIfAbsent.mockImplementation(async (p: UserProfile) => p);

    const me = await service.me(caller({ role: 'admin' }));

    expect(users.createIfAbsent).toHaveBeenCalledWith({
      uid: 'u1',
      email: 'a@example.com',
      displayName: 'Ada',
      photoURL: 'https://example.com/a.png',
      role: 'admin',
      status: 'active',
      roleChangedAt: null,
    });
    expect(me.photoURL).toBe('https://example.com/a.png');
  });

  it('takes the role from the verified claim, not the stored mirror', async () => {
    users.get.mockResolvedValue({ ...stored, role: 'admin' });

    const me = await service.me(caller());

    expect(me.role).toBe('user');
    expect(users.setRole).toHaveBeenCalledWith('u1', 'user');
  });

  it('does not let a token older than the last role change revert the mirror', async () => {
    users.get.mockResolvedValue({
      ...stored,
      role: 'admin',
      roleChangedAt: new Date('2026-06-01T12:30:00Z'),
    });

    const me = await service.me(caller()); // token issued 12:00, claim still 'user'

    expect(me.role).toBe('user');
    expect(users.setRole).not.toHaveBeenCalled();
  });

  it('syncs the mirror from a token issued after the role change', async () => {
    users.get.mockResolvedValue({
      ...stored,
      roleChangedAt: new Date('2026-06-01T11:00:00Z'),
    });

    await service.me(caller({ role: 'admin' }));

    expect(users.setRole).toHaveBeenCalledWith('u1', 'admin');
  });

  it('still answers when the mirror write fails', async () => {
    users.get.mockResolvedValue({ ...stored, role: 'admin' });
    users.setRole.mockRejectedValue(new Error('unavailable'));

    await expect(service.me(caller())).resolves.toMatchObject({ role: 'user' });
  });

  it('reports the effective plan of the personal workspace', async () => {
    users.get.mockResolvedValue(stored);
    workspaces.getPlan.mockResolvedValue({
      id: 'pro',
      status: 'past_due',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    });

    const me = await service.me(caller());

    expect(workspaces.getPlan).toHaveBeenCalledWith('u1');
    expect(me.plan).toBe('pro');
  });
});
