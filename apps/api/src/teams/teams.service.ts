import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type ApiErrorBody,
  type AssignableRole,
  can,
  type CreateInviteResponse,
  effectivePlanId,
  INVITE_TTL_DAYS,
  type InvitePreview,
  type PlanId,
  type PlanLimitErrorBody,
  PLANS,
  type Team,
  type TeamInvite,
  type TeamListResponse,
  type TeamMember,
  type TeamPermission,
  type TeamRole,
} from '@saas-starter/shared';
import type { AuthUser } from '../auth/auth-user';
import { Clock } from '../common/clock';
import { AppConfigService } from '../config/app-config.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { InviteMailer } from './invite.mailer';
import {
  createInviteToken,
  hashSecret,
  parseInviteToken,
  sameHash,
} from './invite-token';
import {
  ActorNotAllowedError,
  type InviteResult,
  type StoredInvite,
  type StoredTeam,
  TeamsRepository,
} from './teams.repository';

const DAY_MS = 86_400_000;

/**
 * Teams, members and invites. Every route resolves the caller's role first
 * (404 for non-members, 403 for a role without the permission); writes that
 * depend on the caller's role re-check it inside their transaction.
 */
@Injectable()
export class TeamsService {
  constructor(
    private readonly teams: TeamsRepository,
    private readonly access: WorkspaceAccessService,
    private readonly mailer: InviteMailer,
    private readonly config: AppConfigService,
    private readonly clock: Clock,
  ) {}

  /** The creator becomes owner. Members beyond the owner need the Team plan. */
  async create(user: AuthUser, name: string): Promise<Team> {
    const team = await this.teams.createTeam(
      { uid: user.uid, email: user.email },
      name,
    );
    return toTeam(team, 'owner');
  }

  async list(user: AuthUser): Promise<TeamListResponse> {
    const memberships = await this.teams.listTeamsForUser(user.uid);
    return { items: memberships.map(({ team, role }) => toTeam(team, role)) };
  }

  async get(user: AuthUser, teamId: string): Promise<Team> {
    const role = await this.memberRole(user, teamId);
    return toTeam(await this.requireTeam(teamId), role);
  }

  async rename(user: AuthUser, teamId: string, name: string): Promise<Team> {
    const role = await this.requirePermission(user, teamId, 'renameTeam');
    await this.asActor(() =>
      this.teams.renameTeam(teamId, name, {
        uid: user.uid,
        allowed: (actorRole) => can(actorRole, 'renameTeam'),
      }),
    );
    return toTeam(await this.requireTeam(teamId), role);
  }

  async listMembers(
    user: AuthUser,
    teamId: string,
  ): Promise<{ items: TeamMember[] }> {
    await this.memberRole(user, teamId);
    const members = await this.teams.listMembers(teamId);
    return {
      items: members.map((m) => ({
        uid: m.uid,
        email: m.email,
        role: m.role,
        joinedAt: m.joinedAt.toISOString(),
      })),
    };
  }

  /** Owner only; the owner's own role never changes (there's one owner). */
  async setRole(
    user: AuthUser,
    teamId: string,
    uid: string,
    role: AssignableRole,
  ): Promise<void> {
    await this.requirePermission(user, teamId, 'changeRoles');
    if (!(await this.teams.setMemberRole(teamId, uid, role))) {
      throw new NotFoundException('Member not found');
    }
  }

  /**
   * Owners and admins remove members; admins can't remove admins; nobody
   * removes the owner. Anyone but the owner can leave (remove themselves).
   */
  async removeMember(
    user: AuthUser,
    teamId: string,
    uid: string,
  ): Promise<void> {
    const callerRole = await this.memberRole(user, teamId);
    const leaving = uid === user.uid;
    if (leaving && callerRole === 'owner') {
      throw new ForbiddenException('The owner can’t leave the team');
    }
    if (!leaving && !can(callerRole, 'removeMembers')) throw notAllowed();

    const removed = await this.asActor(() =>
      this.teams.removeMember(teamId, uid, user.uid, (actorRole, target) =>
        leaving
          ? actorRole !== 'owner'
          : can(actorRole, 'removeMembers') &&
            (actorRole === 'owner' || target === 'member'),
      ),
    );
    if (!removed) throw new NotFoundException('Member not found');
  }

  async invite(
    user: AuthUser,
    teamId: string,
    body: { email: string; role: AssignableRole },
  ): Promise<CreateInviteResponse> {
    const callerRole = await this.requirePermission(
      user,
      teamId,
      'inviteMembers',
    );
    if (body.role === 'admin' && !can(callerRole, 'inviteAdmins')) {
      throw new ForbiddenException('Only the owner can invite admins');
    }
    const team = await this.requireTeam(teamId);
    // Early, friendly check; accepting re-checks seats atomically.
    const plan = effectivePlanId(team.plan);
    const limit = PLANS[plan].limits.members;
    if (limit !== null && team.memberCount >= limit)
      throw seatLimit(plan, limit);

    const inviteId = this.teams.newInviteId(teamId);
    const { token, secretHash } = createInviteToken(teamId, inviteId);
    const invite = await this.asActor(() =>
      this.teams.createInvite(
        teamId,
        inviteId,
        {
          email: body.email,
          role: body.role,
          invitedBy: user.uid,
          secretHash,
          expiresAt: new Date(
            this.clock.now().getTime() + INVITE_TTL_DAYS * DAY_MS,
          ),
        },
        {
          uid: user.uid,
          allowed: (role) =>
            can(role, 'inviteMembers') &&
            (body.role !== 'admin' || can(role, 'inviteAdmins')),
        },
      ),
    );
    // The token rides in the fragment: browsers never send it to servers, so
    // it stays out of access logs, proxies and Referer headers.
    const acceptUrl = `${this.config.appUrl}/invite#token=${encodeURIComponent(token)}`;
    await this.mailer.send({
      to: body.email,
      teamName: team.name,
      invitedBy: user.email,
      acceptUrl,
    });
    return { invite: toInvite(invite), acceptUrl };
  }

  async listInvites(
    user: AuthUser,
    teamId: string,
  ): Promise<{ items: TeamInvite[] }> {
    await this.requirePermission(user, teamId, 'inviteMembers');
    return { items: (await this.teams.listInvites(teamId)).map(toInvite) };
  }

  async revokeInvite(
    user: AuthUser,
    teamId: string,
    inviteId: string,
  ): Promise<void> {
    await this.requirePermission(user, teamId, 'revokeInvites');
    const revoked = await this.asActor(() =>
      this.teams.revokeInvite(teamId, inviteId, {
        uid: user.uid,
        allowed: (role) => can(role, 'revokeInvites'),
      }),
    );
    if (!revoked) throw new NotFoundException('No pending invite with that id');
  }

  /** What an invite is for, so the (signed-in) invitee can decide. */
  async preview(token: string): Promise<InvitePreview> {
    const parsed = parseInviteToken(token);
    const invite =
      parsed && (await this.teams.getInvite(parsed.teamId, parsed.inviteId));
    const team = parsed && invite && (await this.teams.getTeam(parsed.teamId));
    if (
      !parsed ||
      !invite ||
      !team ||
      invite.status !== 'pending' ||
      !sameHash(invite.secretHash, hashSecret(parsed.secret))
    ) {
      throw inviteError('invalid');
    }
    if (invite.expiresAt.getTime() <= this.clock.now().getTime()) {
      throw inviteError('expired');
    }
    return {
      teamName: team.name,
      role: invite.role,
      email: invite.email,
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  async accept(user: AuthUser, token: string): Promise<Team> {
    const result = await this.resolve(user, token, 'accept');
    if (!result.ok) throw toHttpError(result);
    return this.get(user, result.teamId);
  }

  async decline(user: AuthUser, token: string): Promise<void> {
    const result = await this.resolve(user, token, 'decline');
    if (!result.ok) throw toHttpError(result);
  }

  private async resolve(
    user: AuthUser,
    token: string,
    action: 'accept' | 'decline',
  ): Promise<InviteResult> {
    // Anyone can sign up with an address they don't own: only a verified
    // email proves the invite reached its intended recipient.
    if (!user.email || !user.emailVerified) {
      throw new ForbiddenException(
        errorBody(
          403,
          'email_not_verified',
          'Verify your email address to accept invites',
        ),
      );
    }
    const parsed = parseInviteToken(token);
    if (!parsed) throw inviteError('invalid');
    const invitee = { uid: user.uid, email: user.email };
    const secretHash = hashSecret(parsed.secret);
    const now = this.clock.now();
    return action === 'accept'
      ? this.teams.acceptInvite(
          parsed.teamId,
          parsed.inviteId,
          secretHash,
          invitee,
          now,
        )
      : this.teams.declineInvite(
          parsed.teamId,
          parsed.inviteId,
          secretHash,
          invitee,
          now,
        );
  }

  /** The caller's role; 404 for non-members and for personal workspaces. */
  private async memberRole(user: AuthUser, teamId: string): Promise<TeamRole> {
    if (teamId === user.uid) throw teamNotFound();
    const role = await this.access.getRole(user, teamId);
    if (!role) throw teamNotFound();
    return role;
  }

  private async requirePermission(
    user: AuthUser,
    teamId: string,
    permission: TeamPermission,
  ): Promise<TeamRole> {
    const role = await this.memberRole(user, teamId);
    if (!can(role, permission)) throw notAllowed();
    return role;
  }

  private async requireTeam(teamId: string): Promise<StoredTeam> {
    const team = await this.teams.getTeam(teamId);
    if (!team) throw teamNotFound();
    return team;
  }

  /** The actor's role changed under us (demoted or removed): refuse. */
  private async asActor<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (err instanceof ActorNotAllowedError) throw notAllowed();
      throw err;
    }
  }
}

function toTeam(team: StoredTeam, role: TeamRole): Team {
  return {
    id: team.id,
    name: team.name,
    role,
    plan: effectivePlanId(team.plan),
    memberCount: team.memberCount,
    createdAt: team.createdAt.toISOString(),
  };
}

function toInvite(invite: Omit<StoredInvite, 'secretHash'>): TeamInvite {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    status: invite.status,
    invitedBy: invite.invitedBy,
    createdAt: invite.createdAt.toISOString(),
    expiresAt: invite.expiresAt.toISOString(),
  };
}

function toHttpError(result: Exclude<InviteResult, { ok: true }>) {
  switch (result.reason) {
    case 'seat_limit':
      return seatLimit(result.plan, result.limit);
    case 'already_member':
      return new ConflictException(
        errorBody(409, 'already_member', 'You’re already in this team'),
      );
    default:
      return inviteError(result.reason);
  }
}

function seatLimit(plan: PlanId, limit: number) {
  const body: PlanLimitErrorBody = {
    statusCode: 403,
    code: 'plan_limit_reached',
    message: `Your ${PLANS[plan].name} plan allows ${limit} member${limit === 1 ? '' : 's'}.${
      plan === 'team' ? '' : ' Upgrade to Team to invite people.'
    }`,
    resource: 'members',
    limit,
    plan,
  };
  return new ForbiddenException(body);
}

function inviteError(reason: 'invalid' | 'expired' | 'email_mismatch') {
  switch (reason) {
    case 'expired':
      return new GoneException(
        errorBody(
          410,
          'invite_expired',
          'This invite has expired; ask for a new one',
        ),
      );
    case 'email_mismatch':
      return new ForbiddenException(
        errorBody(
          403,
          'invite_email_mismatch',
          'This invite was sent to a different email address',
        ),
      );
    default:
      return new NotFoundException(
        errorBody(404, 'invite_invalid', 'This invite is no longer valid'),
      );
  }
}

function teamNotFound() {
  return new NotFoundException('Team not found');
}

function notAllowed() {
  return new ForbiddenException('Your role in this team does not allow that');
}

function errorBody<C extends ApiErrorBody['code']>(
  statusCode: number,
  code: C,
  message: string,
): ApiErrorBody<C> {
  return { statusCode, code, message };
}
