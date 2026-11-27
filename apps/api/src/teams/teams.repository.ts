import { Inject, Injectable } from '@nestjs/common';
import {
  type AssignableRole,
  effectivePlanId,
  hasRoomFor,
  type InviteStatus,
  type PlanId,
  PLANS,
  TEAM_ROLES,
  type TeamRole,
  type WorkspacePlan,
} from '@saas-starter/shared';
import {
  FieldValue,
  type Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.tokens';
import { isDeletionLocked } from '../workspaces/workspace-docs';
import { toWorkspacePlan } from '../workspaces/workspaces.repository';
import { sameHash } from './invite-token';

export interface StoredTeam {
  id: string;
  name: string;
  ownerUid: string;
  plan: WorkspacePlan | null;
  memberCount: number;
  createdAt: Date;
}

export interface StoredMember {
  uid: string;
  email: string | null;
  role: TeamRole;
  joinedAt: Date;
}

export interface StoredInvite {
  id: string;
  teamId: string;
  email: string;
  role: AssignableRole;
  status: InviteStatus;
  invitedBy: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface NewInvite {
  email: string;
  role: AssignableRole;
  invitedBy: string;
  secretHash: string;
  expiresAt: Date;
}

/** Who is accepting an invite, from the verified ID token. */
export interface Invitee {
  uid: string;
  email: string;
}

/**
 * The caller of a team write. Their role is re-read inside the write's
 * transaction, so someone demoted or removed a moment ago can't finish.
 */
export interface Actor {
  uid: string;
  allowed: (actorRole: TeamRole) => boolean;
}

/** The team is locked by its owner's account deletion. */
export class TeamDeletingError extends Error {
  constructor() {
    super('The team is being deleted');
  }
}

/** The actor's current role doesn't allow the write (anymore). */
export class ActorNotAllowedError extends Error {
  constructor() {
    super('Not allowed');
  }
}

export type InviteResult =
  | { ok: true; teamId: string }
  | {
      ok: false;
      reason:
        | 'invalid'
        | 'expired'
        | 'email_mismatch'
        | 'already_member'
        | 'team_deleting';
    }
  | { ok: false; reason: 'seat_limit'; plan: PlanId; limit: number };

export abstract class TeamsRepository {
  /** Creates the team workspace and its owner member in one batch. */
  abstract createTeam(
    owner: { uid: string; email: string | null },
    name: string,
  ): Promise<StoredTeam>;
  abstract getTeam(teamId: string): Promise<StoredTeam | null>;
  /** Teams the user is a member of, with their role. */
  abstract listTeamsForUser(
    uid: string,
  ): Promise<{ team: StoredTeam; role: TeamRole }[]>;
  /** @throws ActorNotAllowedError */
  abstract renameTeam(
    teamId: string,
    name: string,
    actor: Actor,
  ): Promise<void>;
  abstract listMembers(teamId: string): Promise<StoredMember[]>;
  /** False if not a member, or the member is the owner (whose role is fixed). */
  abstract setMemberRole(
    teamId: string,
    uid: string,
    role: AssignableRole,
  ): Promise<boolean>;
  /**
   * Removes a member and decrements `memberCount`. `canRemove` sees the
   * actor's and the target's role inside the transaction (e.g. admins can't
   * remove admins). False if not a member; the owner is never removed.
   * @throws ActorNotAllowedError
   */
  abstract removeMember(
    teamId: string,
    uid: string,
    actorUid: string,
    canRemove: (actorRole: TeamRole, targetRole: TeamRole) => boolean,
  ): Promise<boolean>;

  /**
   * Creates a pending invite, revoking earlier pending invites to the same email.
   * @throws ActorNotAllowedError
   * @throws TeamDeletingError
   */
  abstract createInvite(
    teamId: string,
    inviteId: string,
    invite: NewInvite,
    actor: Actor,
  ): Promise<StoredInvite>;
  /** A fresh id for an invite doc (needed in the token before it's stored). */
  abstract newInviteId(teamId: string): string;
  abstract listInvites(teamId: string): Promise<StoredInvite[]>;
  abstract getInvite(
    teamId: string,
    inviteId: string,
  ): Promise<(StoredInvite & { secretHash: string }) | null>;
  /**
   * Pending → revoked. False if not pending.
   * @throws ActorNotAllowedError
   */
  abstract revokeInvite(
    teamId: string,
    inviteId: string,
    actor: Actor,
  ): Promise<boolean>;
  /** Checks the secret, expiry, email and seats, and joins, all in one transaction. */
  abstract acceptInvite(
    teamId: string,
    inviteId: string,
    secretHash: string,
    invitee: Invitee,
    now: Date,
  ): Promise<InviteResult>;
  abstract declineInvite(
    teamId: string,
    inviteId: string,
    secretHash: string,
    invitee: Invitee,
    now: Date,
  ): Promise<InviteResult>;
}

const MAX_TEAMS_PER_USER = 100;

@Injectable()
export class FirestoreTeamsRepository extends TeamsRepository {
  constructor(@Inject(FIRESTORE) private readonly db: Firestore) {
    super();
  }

  private team(id: string) {
    return this.db.collection('workspaces').doc(id);
  }

  async createTeam(owner: { uid: string; email: string | null }, name: string) {
    const ref = this.db.collection('workspaces').doc();
    const batch = this.db.batch();
    batch.create(ref, {
      type: 'team',
      name,
      ownerUid: owner.uid,
      plan: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      linkCount: 0,
      memberCount: 1,
      createdAt: FieldValue.serverTimestamp(),
    });
    batch.create(ref.collection('members').doc(owner.uid), {
      uid: owner.uid,
      email: owner.email,
      role: 'owner',
      joinedAt: FieldValue.serverTimestamp(),
    });
    await batch.commit();
    const team = await this.getTeam(ref.id);
    if (!team) throw new Error(`Team ${ref.id} vanished after create`);
    return team;
  }

  async getTeam(teamId: string): Promise<StoredTeam | null> {
    const snap = await this.team(teamId).get();
    return snap.exists && snap.get('type') === 'team'
      ? toTeam(snap.id, snap.data() ?? {})
      : null;
  }

  async listTeamsForUser(uid: string) {
    // Collection-group query on members.uid (index in firestore.indexes.json).
    const memberships = await this.db
      .collectionGroup('members')
      .where('uid', '==', uid)
      .limit(MAX_TEAMS_PER_USER)
      .get();
    // Keep each membership paired with its team (a parentless doc is skipped).
    const pairs = memberships.docs.flatMap((doc) => {
      const teamRef = doc.ref.parent.parent;
      return teamRef ? [{ teamRef, role: toRole(doc.get('role')) }] : [];
    });
    if (pairs.length === 0) return [];
    const teams = await this.db.getAll(...pairs.map((pair) => pair.teamRef));
    return teams.flatMap((snap, i) =>
      snap.exists && snap.get('type') === 'team'
        ? [{ team: toTeam(snap.id, snap.data() ?? {}), role: pairs[i].role }]
        : [],
    );
  }

  async renameTeam(teamId: string, name: string, actor: Actor): Promise<void> {
    const actorRef = this.team(teamId).collection('members').doc(actor.uid);
    await this.db.runTransaction(async (tx) => {
      const actorSnap = await tx.get(actorRef);
      if (!actorSnap.exists || !actor.allowed(toRole(actorSnap.get('role')))) {
        throw new ActorNotAllowedError();
      }
      tx.update(this.team(teamId), { name });
    });
  }

  async listMembers(teamId: string): Promise<StoredMember[]> {
    const snap = await this.team(teamId)
      .collection('members')
      .orderBy('joinedAt')
      .get();
    return snap.docs.map((doc) => ({
      uid: doc.id,
      email: typeof doc.get('email') === 'string' ? doc.get('email') : null,
      role: toRole(doc.get('role')),
      joinedAt: toDate(doc.get('joinedAt')),
    }));
  }

  async setMemberRole(
    teamId: string,
    uid: string,
    role: AssignableRole,
  ): Promise<boolean> {
    const ref = this.team(teamId).collection('members').doc(uid);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.get('role') === 'owner') return false;
      tx.update(ref, { role });
      return true;
    });
  }

  async removeMember(
    teamId: string,
    uid: string,
    actorUid: string,
    canRemove: (actorRole: TeamRole, targetRole: TeamRole) => boolean,
  ): Promise<boolean> {
    const members = this.team(teamId).collection('members');
    const ref = members.doc(uid);
    return this.db.runTransaction(async (tx) => {
      const [target, actor] = await Promise.all([
        tx.get(ref),
        tx.get(members.doc(actorUid)),
      ]);
      if (!actor.exists) throw new ActorNotAllowedError();
      if (!target.exists) return false;
      const role = toRole(target.get('role'));
      if (role === 'owner' || !canRemove(toRole(actor.get('role')), role)) {
        throw new ActorNotAllowedError();
      }
      tx.delete(ref);
      tx.update(this.team(teamId), { memberCount: FieldValue.increment(-1) });
      return true;
    });
  }

  newInviteId(teamId: string): string {
    return this.team(teamId).collection('invites').doc().id;
  }

  async createInvite(
    teamId: string,
    inviteId: string,
    invite: NewInvite,
    actor: Actor,
  ): Promise<StoredInvite> {
    const invites = this.team(teamId).collection('invites');
    const actorRef = this.team(teamId).collection('members').doc(actor.uid);
    await this.db.runTransaction(async (tx) => {
      const [actorSnap, earlier, team] = await Promise.all([
        tx.get(actorRef),
        tx.get(invites.where('email', '==', invite.email)),
        tx.get(this.team(teamId)),
      ]);
      if (!actorSnap.exists || !actor.allowed(toRole(actorSnap.get('role')))) {
        throw new ActorNotAllowedError();
      }
      if (isDeletionLocked(team.get('deletingAt'), new Date())) {
        throw new TeamDeletingError();
      }
      for (const doc of earlier.docs) {
        if (doc.get('status') === 'pending')
          tx.update(doc.ref, { status: 'revoked' });
      }
      tx.create(invites.doc(inviteId), {
        email: invite.email,
        role: invite.role,
        status: 'pending',
        invitedBy: invite.invitedBy,
        secretHash: invite.secretHash,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromDate(invite.expiresAt),
      });
    });
    const stored = await this.getInvite(teamId, inviteId);
    if (!stored) throw new Error(`Invite ${inviteId} vanished after create`);
    return withoutSecret(stored);
  }

  async listInvites(teamId: string): Promise<StoredInvite[]> {
    const snap = await this.team(teamId)
      .collection('invites')
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();
    return snap.docs.map((doc) =>
      withoutSecret(toInvite(teamId, doc.id, doc.data())),
    );
  }

  async getInvite(teamId: string, inviteId: string) {
    const snap = await this.team(teamId)
      .collection('invites')
      .doc(inviteId)
      .get();
    return snap.exists ? toInvite(teamId, snap.id, snap.data() ?? {}) : null;
  }

  async revokeInvite(
    teamId: string,
    inviteId: string,
    actor: Actor,
  ): Promise<boolean> {
    const ref = this.team(teamId).collection('invites').doc(inviteId);
    const actorRef = this.team(teamId).collection('members').doc(actor.uid);
    return this.db.runTransaction(async (tx) => {
      const [snap, actorSnap] = await Promise.all([
        tx.get(ref),
        tx.get(actorRef),
      ]);
      if (!actorSnap.exists || !actor.allowed(toRole(actorSnap.get('role')))) {
        throw new ActorNotAllowedError();
      }
      if (!snap.exists || snap.get('status') !== 'pending') return false;
      tx.update(ref, { status: 'revoked' });
      return true;
    });
  }

  acceptInvite(
    teamId: string,
    inviteId: string,
    secretHash: string,
    invitee: Invitee,
    now: Date,
  ) {
    return this.resolveInvite(
      teamId,
      inviteId,
      secretHash,
      invitee,
      now,
      'accepted',
    );
  }

  declineInvite(
    teamId: string,
    inviteId: string,
    secretHash: string,
    invitee: Invitee,
    now: Date,
  ) {
    return this.resolveInvite(
      teamId,
      inviteId,
      secretHash,
      invitee,
      now,
      'declined',
    );
  }

  private resolveInvite(
    teamId: string,
    inviteId: string,
    secretHash: string,
    invitee: Invitee,
    now: Date,
    outcome: 'accepted' | 'declined',
  ): Promise<InviteResult> {
    const teamRef = this.team(teamId);
    const inviteRef = teamRef.collection('invites').doc(inviteId);
    const memberRef = teamRef.collection('members').doc(invitee.uid);

    return this.db.runTransaction(async (tx): Promise<InviteResult> => {
      const [invite, team, member] = await Promise.all([
        tx.get(inviteRef),
        tx.get(teamRef),
        tx.get(memberRef),
      ]);
      // Same answer for "no such invite" and "wrong secret": nothing to probe.
      if (
        !invite.exists ||
        !team.exists ||
        invite.get('status') !== 'pending' ||
        !sameHash(String(invite.get('secretHash') ?? ''), secretHash)
      ) {
        return { ok: false, reason: 'invalid' };
      }
      if (toDate(invite.get('expiresAt')).getTime() <= now.getTime()) {
        return { ok: false, reason: 'expired' };
      }
      if (invite.get('email') !== invitee.email.toLowerCase()) {
        return { ok: false, reason: 'email_mismatch' };
      }

      if (outcome === 'declined') {
        tx.update(inviteRef, {
          status: 'declined',
          resolvedBy: invitee.uid,
          resolvedAt: FieldValue.serverTimestamp(),
        });
        return { ok: true, teamId };
      }

      if (member.exists) return { ok: false, reason: 'already_member' };
      // Its owner is deleting their account (and with it this team).
      if (isDeletionLocked(team.get('deletingAt'), now)) {
        return { ok: false, reason: 'team_deleting' };
      }
      // Seats are checked against the stored count in this transaction, so
      // concurrent accepts can't overshoot the plan's limit.
      const plan = effectivePlanId(toWorkspacePlan(team.get('plan')));
      const limit = PLANS[plan].limits.members;
      const used =
        typeof team.get('memberCount') === 'number'
          ? team.get('memberCount')
          : 1;
      if (!hasRoomFor(used, limit)) {
        return { ok: false, reason: 'seat_limit', plan, limit: limit ?? 0 };
      }

      tx.create(memberRef, {
        uid: invitee.uid,
        email: invitee.email.toLowerCase(),
        role: invite.get('role') === 'admin' ? 'admin' : 'member',
        joinedAt: FieldValue.serverTimestamp(),
      });
      tx.update(teamRef, { memberCount: FieldValue.increment(1) });
      tx.update(inviteRef, {
        status: 'accepted',
        resolvedBy: invitee.uid,
        resolvedAt: FieldValue.serverTimestamp(),
      });
      return { ok: true, teamId };
    });
  }
}

function toTeam(id: string, data: Record<string, unknown>): StoredTeam {
  return {
    id,
    name: typeof data['name'] === 'string' ? data['name'] : 'Team',
    ownerUid: String(data['ownerUid'] ?? ''),
    plan: toWorkspacePlan(data['plan']),
    memberCount:
      typeof data['memberCount'] === 'number' ? data['memberCount'] : 1,
    createdAt: toDate(data['createdAt']),
  };
}

function toInvite(teamId: string, id: string, data: Record<string, unknown>) {
  return {
    id,
    teamId,
    email: String(data['email'] ?? ''),
    role: (data['role'] === 'admin' ? 'admin' : 'member') as AssignableRole,
    status: (['pending', 'accepted', 'declined', 'revoked'].includes(
      String(data['status']),
    )
      ? data['status']
      : 'revoked') as InviteStatus,
    invitedBy: String(data['invitedBy'] ?? ''),
    createdAt: toDate(data['createdAt']),
    expiresAt: toDate(data['expiresAt']),
    secretHash: String(data['secretHash'] ?? ''),
  };
}

function withoutSecret<T extends { secretHash: string }>(
  invite: T,
): Omit<T, 'secretHash'> {
  const { secretHash, ...rest } = invite;
  void secretHash; // never leaves the repository
  return rest;
}

function toRole(value: unknown): TeamRole {
  return (TEAM_ROLES as readonly unknown[]).includes(value)
    ? (value as TeamRole)
    : 'member';
}

function toDate(value: unknown): Date {
  return value instanceof Timestamp ? value.toDate() : new Date(0);
}
