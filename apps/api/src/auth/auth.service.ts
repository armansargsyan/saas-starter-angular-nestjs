import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { effectivePlanId, type MeResponse } from '@saas-starter/shared';
import { IdentityProvider } from '../firebase/identity.provider';
import { WorkspacesRepository } from '../workspaces/workspaces.repository';
import type { AuthUser } from './auth-user';
import { type UserProfile, UsersRepository } from './users.repository';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly identity: IdentityProvider,
    private readonly users: UsersRepository,
    private readonly workspaces: WorkspacesRepository,
  ) {}

  /** The caller's profile; creates `users/{uid}` on first sign-in. */
  async me(user: AuthUser): Promise<MeResponse> {
    const profile =
      (await this.users.get(user.uid)) ?? (await this.createProfile(user));

    await this.syncRoleMirror(user, profile);

    // Personal workspace id = uid.
    const plan = effectivePlanId(await this.workspaces.getPlan(user.uid));

    return {
      uid: user.uid,
      // Prefer the token's email: the stored one goes stale if it changes.
      email: user.email ?? profile.email,
      displayName: profile.displayName,
      photoURL: profile.photoURL,
      role: user.role,
      plan,
    };
  }

  /**
   * The verified claim is the source of truth; keep the stored mirror in step
   * (e.g. a role granted before the first sign-in). Only a token issued after
   * the last role change may correct it, so a stale token can't undo a fresh
   * grant. Best effort: the mirror never decides access, so /me doesn't fail.
   */
  private async syncRoleMirror(user: AuthUser, profile: UserProfile) {
    if (profile.role === user.role) return;
    if (profile.roleChangedAt && user.tokenIssuedAt <= profile.roleChangedAt) {
      return;
    }
    try {
      await this.users.setRole(user.uid, user.role);
    } catch (err) {
      this.logger.warn(
        `Could not sync role mirror for ${user.uid}: ${(err as Error).message}`,
      );
    }
  }

  private async createProfile(user: AuthUser): Promise<UserProfile> {
    const record = await this.identity.getUser(user.uid);
    if (!record) {
      // Deleted between token verification and now.
      throw new UnauthorizedException('Account no longer exists');
    }
    return this.users.createIfAbsent({
      uid: user.uid,
      email: record.email,
      displayName: record.displayName,
      photoURL: record.photoURL,
      role: user.role,
      status: 'active',
      roleChangedAt: null,
    });
  }
}
