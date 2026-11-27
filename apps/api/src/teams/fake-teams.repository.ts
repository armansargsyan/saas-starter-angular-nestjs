import {
  type AssignableRole,
  effectivePlanId,
  hasRoomFor,
  PLANS,
  type TeamRole,
  type WorkspacePlan,
} from '@saas-starter/shared';
import { sameHash } from './invite-token';
import {
  type Actor,
  ActorNotAllowedError,
  type Invitee,
  type InviteResult,
  type NewInvite,
  type StoredInvite,
  type StoredMember,
  type StoredTeam,
  TeamsRepository,
} from './teams.repository';

type Invite = StoredInvite & { secretHash: string };

/** In-memory TeamsRepository for HTTP specs; mirrors the Firestore rules. */
export class FakeTeamsRepository extends TeamsRepository {
  readonly teams = new Map<string, StoredTeam>();
  readonly members = new Map<string, Map<string, StoredMember>>();
  readonly invites = new Map<string, Map<string, Invite>>();
  private nextId = 1;
  now = () => new Date();

  /** For the WorkspacesRepository fake. */
  roleOf(teamId: string, uid: string): TeamRole | null {
    return this.members.get(teamId)?.get(uid)?.role ?? null;
  }

  setPlan(teamId: string, plan: WorkspacePlan | null) {
    const team = this.teams.get(teamId);
    if (team) team.plan = plan;
  }

  async createTeam(owner: { uid: string; email: string | null }, name: string) {
    const id = `team${this.nextId++}`;
    const team: StoredTeam = {
      id,
      name,
      ownerUid: owner.uid,
      plan: null,
      memberCount: 1,
      createdAt: this.now(),
    };
    this.teams.set(id, team);
    this.members.set(
      id,
      new Map([
        [
          owner.uid,
          {
            uid: owner.uid,
            email: owner.email,
            role: 'owner',
            joinedAt: this.now(),
          },
        ],
      ]),
    );
    this.invites.set(id, new Map());
    return { ...team };
  }

  async getTeam(teamId: string) {
    const team = this.teams.get(teamId);
    return team ? { ...team } : null;
  }

  async listTeamsForUser(uid: string) {
    return [...this.teams.values()].flatMap((team) => {
      const role = this.roleOf(team.id, uid);
      return role ? [{ team: { ...team }, role }] : [];
    });
  }

  async renameTeam(teamId: string, name: string, actor: Actor) {
    this.assertActor(teamId, actor);
    const team = this.teams.get(teamId);
    if (team) team.name = name;
  }

  async listMembers(teamId: string) {
    return [...(this.members.get(teamId)?.values() ?? [])];
  }

  async setMemberRole(teamId: string, uid: string, role: AssignableRole) {
    const member = this.members.get(teamId)?.get(uid);
    if (!member || member.role === 'owner') return false;
    member.role = role;
    return true;
  }

  async removeMember(
    teamId: string,
    uid: string,
    actorUid: string,
    canRemove: (actorRole: TeamRole, targetRole: TeamRole) => boolean,
  ) {
    const members = this.members.get(teamId);
    const actorRole = this.roleOf(teamId, actorUid);
    if (!actorRole) throw new ActorNotAllowedError();
    const member = members?.get(uid);
    if (!members || !member) return false;
    if (member.role === 'owner' || !canRemove(actorRole, member.role)) {
      throw new ActorNotAllowedError();
    }
    members.delete(uid);
    const team = this.teams.get(teamId);
    if (team) team.memberCount--;
    return true;
  }

  newInviteId() {
    return `inv${this.nextId++}`;
  }

  async createInvite(
    teamId: string,
    inviteId: string,
    invite: NewInvite,
    actor: Actor,
  ) {
    this.assertActor(teamId, actor);
    const invites = this.invites.get(teamId) ?? new Map<string, Invite>();
    for (const earlier of invites.values()) {
      if (earlier.email === invite.email && earlier.status === 'pending')
        earlier.status = 'revoked';
    }
    const stored: Invite = {
      id: inviteId,
      teamId,
      email: invite.email,
      role: invite.role,
      status: 'pending',
      invitedBy: invite.invitedBy,
      createdAt: this.now(),
      expiresAt: invite.expiresAt,
      secretHash: invite.secretHash,
    };
    invites.set(inviteId, stored);
    this.invites.set(teamId, invites);
    const { secretHash: _s, ...rest } = stored;
    void _s;
    return rest;
  }

  async listInvites(teamId: string) {
    return [...(this.invites.get(teamId)?.values() ?? [])].map(
      ({ secretHash: _s, ...rest }) => {
        void _s;
        return rest;
      },
    );
  }

  async getInvite(teamId: string, inviteId: string) {
    const invite = this.invites.get(teamId)?.get(inviteId);
    return invite ? { ...invite } : null;
  }

  async revokeInvite(teamId: string, inviteId: string, actor: Actor) {
    this.assertActor(teamId, actor);
    const invite = this.invites.get(teamId)?.get(inviteId);
    if (!invite || invite.status !== 'pending') return false;
    invite.status = 'revoked';
    return true;
  }

  private assertActor(teamId: string, actor: Actor) {
    const role = this.roleOf(teamId, actor.uid);
    if (!role || !actor.allowed(role)) throw new ActorNotAllowedError();
  }

  async acceptInvite(
    teamId: string,
    inviteId: string,
    secretHash: string,
    invitee: Invitee,
    now: Date,
  ) {
    return this.resolve(teamId, inviteId, secretHash, invitee, now, 'accepted');
  }

  async declineInvite(
    teamId: string,
    inviteId: string,
    secretHash: string,
    invitee: Invitee,
    now: Date,
  ) {
    return this.resolve(teamId, inviteId, secretHash, invitee, now, 'declined');
  }

  private resolve(
    teamId: string,
    inviteId: string,
    secretHash: string,
    invitee: Invitee,
    now: Date,
    outcome: 'accepted' | 'declined',
  ): InviteResult {
    const team = this.teams.get(teamId);
    const invite = this.invites.get(teamId)?.get(inviteId);
    if (
      !team ||
      !invite ||
      invite.status !== 'pending' ||
      !sameHash(invite.secretHash, secretHash)
    ) {
      return { ok: false, reason: 'invalid' };
    }
    if (invite.expiresAt.getTime() <= now.getTime())
      return { ok: false, reason: 'expired' };
    if (invite.email !== invitee.email.toLowerCase())
      return { ok: false, reason: 'email_mismatch' };
    if (outcome === 'declined') {
      invite.status = 'declined';
      return { ok: true, teamId };
    }
    if (this.roleOf(teamId, invitee.uid))
      return { ok: false, reason: 'already_member' };
    const plan = effectivePlanId(team.plan);
    const limit = PLANS[plan].limits.members;
    if (!hasRoomFor(team.memberCount, limit))
      return { ok: false, reason: 'seat_limit', plan, limit: limit ?? 0 };
    this.members.get(teamId)?.set(invitee.uid, {
      uid: invitee.uid,
      email: invitee.email.toLowerCase(),
      role: invite.role,
      joinedAt: this.now(),
    });
    team.memberCount++;
    invite.status = 'accepted';
    return { ok: true, teamId };
  }
}
