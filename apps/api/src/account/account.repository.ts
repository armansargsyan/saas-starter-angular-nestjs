import { Inject, Injectable } from '@nestjs/common';
import { TEAM_ROLES, type TeamRole } from '@saas-starter/shared';
import {
  type DocumentReference,
  FieldValue,
  type Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.tokens';
import { newPersonalWorkspace } from '../workspaces/workspace-docs';

/** A team the user is in, as account deletion needs it. */
export interface Membership {
  teamId: string;
  role: TeamRole;
  /** False when the team doc is gone (e.g. a deletion that stopped halfway). */
  teamExists: boolean;
  teamName: string;
  memberCount: number;
}

/** The team has (or gained) other members: it can't go with the account. */
export class TeamHasMembersError extends Error {
  constructor(readonly teamId: string) {
    super(`Team ${teamId} has other members`);
  }
}

/** The member doc says "owner", but the team doc names someone else. */
export class TeamNotOwnedError extends Error {
  constructor(
    readonly teamId: string,
    uid: string,
  ) {
    super(`Team ${teamId} is not owned by ${uid}, despite its member doc`);
  }
}

/**
 * The Firestore side of account deletion and profile edits. Every write is
 * idempotent, so a deletion that fails halfway can simply be retried.
 */
export abstract class AccountRepository {
  /** Every team membership of `uid`, including teams whose doc is gone. */
  abstract listMemberships(uid: string): Promise<Membership[]>;
  /**
   * Re-checks, in a transaction, that the owner is the team's only member
   * and locks it (`deletingAt`, see DELETION_LOCK_MS): nobody can join it
   * or be invited to it from now on. Re-locking is fine; a team that's
   * already gone is skipped.
   * @throws TeamHasMembersError
   * @throws TeamNotOwnedError
   */
  abstract lockOwnedTeam(
    teamId: string,
    ownerUid: string,
    now: Date,
  ): Promise<void>;
  /**
   * Locks the personal workspace the same way (`deletingAt`), so a checkout
   * started meanwhile is refused. Creates the doc if there's none yet, so
   * the lock holds before the first checkout too.
   */
  abstract lockPersonalWorkspace(uid: string, now: Date): Promise<void>;
  abstract stripeCustomerId(workspaceId: string): Promise<string | null>;
  /**
   * Deletes the (locked) team doc only, in a transaction that checks it once
   * more; from then on invites to it are invalid. Its data goes with
   * `deleteWorkspaceData`. A no-op when the doc is already gone.
   * @throws TeamHasMembersError
   * @throws TeamNotOwnedError
   */
  abstract deleteOwnedTeamDoc(teamId: string, ownerUid: string): Promise<void>;
  /**
   * Deletes the workspace's links with their analytics (retiring the codes,
   * so shared links can't be taken over), the workspace doc with its
   * subcollections, then its subscription mirrors.
   */
  abstract deleteWorkspaceData(workspaceId: string): Promise<void>;
  /**
   * Removes the membership (decrementing `memberCount`) and revokes the
   * pending invites `uid` sent for that team; no-op if not a member.
   */
  abstract leaveTeam(teamId: string, uid: string): Promise<void>;
  /** Mirrors profile fields onto `users/{uid}` (if it exists yet). */
  abstract updateProfile(
    uid: string,
    profile: { displayName?: string | null; photoURL?: string | null },
  ): Promise<void>;
  /** Deletes `users/{uid}`. */
  abstract deleteProfile(uid: string): Promise<void>;
}

const PAGE = 200;
const NOT_FOUND = 5;

@Injectable()
export class FirestoreAccountRepository extends AccountRepository {
  constructor(@Inject(FIRESTORE) private readonly db: Firestore) {
    super();
  }

  private workspace(id: string) {
    return this.db.collection('workspaces').doc(id);
  }

  async listMemberships(uid: string): Promise<Membership[]> {
    // Collection-group query on members.uid (index in firestore.indexes.json).
    const snap = await this.db
      .collectionGroup('members')
      .where('uid', '==', uid)
      .get();
    const pairs = snap.docs.flatMap((doc) => {
      const teamRef = doc.ref.parent.parent;
      return teamRef ? [{ teamRef, role: toRole(doc.get('role')) }] : [];
    });
    if (pairs.length === 0) return [];
    const teams = await this.db.getAll(...pairs.map((pair) => pair.teamRef));
    return teams.map((team, i) => ({
      teamId: team.id,
      role: pairs[i].role,
      teamExists: team.exists,
      teamName:
        typeof team.get('name') === 'string' ? team.get('name') : 'Team',
      memberCount: memberCountOf(team.get('memberCount')),
    }));
  }

  async lockOwnedTeam(
    teamId: string,
    ownerUid: string,
    now: Date,
  ): Promise<void> {
    const ref = this.workspace(teamId);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      assertSoleOwner(
        teamId,
        ownerUid,
        snap.get('ownerUid'),
        snap.get('memberCount'),
      );
      tx.update(ref, { deletingAt: Timestamp.fromDate(now) });
    });
  }

  async lockPersonalWorkspace(uid: string, now: Date): Promise<void> {
    const ref = this.workspace(uid);
    const deletingAt = Timestamp.fromDate(now);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) tx.update(ref, { deletingAt });
      else tx.create(ref, { ...newPersonalWorkspace(uid), deletingAt });
    });
  }

  async stripeCustomerId(workspaceId: string): Promise<string | null> {
    const value = (await this.workspace(workspaceId).get()).get(
      'stripeCustomerId',
    );
    return typeof value === 'string' && value ? value : null;
  }

  async deleteOwnedTeamDoc(teamId: string, ownerUid: string): Promise<void> {
    const ref = this.workspace(teamId);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      assertSoleOwner(
        teamId,
        ownerUid,
        snap.get('ownerUid'),
        snap.get('memberCount'),
      );
      tx.delete(ref);
    });
  }

  async deleteWorkspaceData(workspaceId: string): Promise<void> {
    const links = this.db
      .collection('links')
      .where('workspaceId', '==', workspaceId)
      .limit(PAGE);
    for (;;) {
      const page = await links.get();
      if (page.empty) break;
      const refs = page.docs.map((doc) => doc.ref);
      // Retire first: whatever fails next, the codes can't be reissued.
      // No workspace id on these: nothing ties them to the deleted account.
      const retire = this.db.batch();
      for (const ref of refs) {
        retire.set(this.db.collection('retiredCodes').doc(ref.id), {
          retiredAt: FieldValue.serverTimestamp(),
        });
      }
      await retire.commit();
      // Analytics while the link still exists (a failure here leaves the
      // link, so a retry finds it again), then the link: from then on a
      // click can't write (recordClick updates the link doc in the same
      // batch), and a last sweep removes what a click wrote meanwhile.
      await this.deleteAnalytics(refs);
      const remove = this.db.batch();
      for (const ref of refs) remove.delete(ref);
      await remove.commit();
      await this.deleteAnalytics(refs);
    }

    // The doc and its subcollections (members, invites), before the
    // mirrors: once it's gone, webhooks from our own cancellations find no
    // workspace and write no mirror (BillingRepository.endSubscription).
    await this.db.recursiveDelete(this.workspace(workspaceId));

    // Mirrors feed admin revenue stats; a deleted workspace's would linger.
    const mirrors = await this.db
      .collection('subscriptions')
      .where('workspaceId', '==', workspaceId)
      .get();
    if (!mirrors.empty) {
      const writer = this.db.bulkWriter();
      for (const doc of mirrors.docs) void writer.delete(doc.ref);
      await writer.close();
    }
  }

  private async deleteAnalytics(links: DocumentReference[]): Promise<void> {
    const writer = this.db.bulkWriter();
    await Promise.all(
      links.flatMap((ref) => [
        this.db.recursiveDelete(ref.collection('daily'), writer),
        this.db.recursiveDelete(ref.collection('clicks'), writer),
      ]),
    );
    await writer.close();
  }

  async leaveTeam(teamId: string, uid: string): Promise<void> {
    const team = this.workspace(teamId);
    const member = team.collection('members').doc(uid);
    const sentInvites = team
      .collection('invites')
      .where('invitedBy', '==', uid);
    await this.db.runTransaction(async (tx) => {
      const [memberSnap, teamSnap, invites] = await Promise.all([
        tx.get(member),
        tx.get(team),
        tx.get(sentInvites),
      ]);
      // Links they sent stop working with them.
      for (const invite of invites.docs) {
        if (invite.get('status') === 'pending') {
          tx.update(invite.ref, { status: 'revoked' });
        }
      }
      if (!memberSnap.exists) return;
      tx.delete(member);
      if (teamSnap.exists) {
        tx.update(team, { memberCount: FieldValue.increment(-1) });
      }
    });
  }

  async updateProfile(
    uid: string,
    profile: { displayName?: string | null; photoURL?: string | null },
  ): Promise<void> {
    const fields = Object.fromEntries(
      Object.entries(profile).filter(([, value]) => value !== undefined),
    );
    try {
      await this.db.collection('users').doc(uid).update(fields);
    } catch (err) {
      // No profile yet: /me creates it from the (already updated) Auth record.
      if ((err as { code?: unknown }).code !== NOT_FOUND) throw err;
    }
  }

  async deleteProfile(uid: string): Promise<void> {
    await this.db.collection('users').doc(uid).delete();
  }
}

function assertSoleOwner(
  teamId: string,
  uid: string,
  ownerUid: unknown,
  memberCount: unknown,
): void {
  if (ownerUid !== uid) throw new TeamNotOwnedError(teamId, uid);
  if (memberCountOf(memberCount) > 1) throw new TeamHasMembersError(teamId);
}

function memberCountOf(value: unknown): number {
  return typeof value === 'number' ? value : 1;
}

function toRole(value: unknown): TeamRole {
  return (TEAM_ROLES as readonly unknown[]).includes(value)
    ? (value as TeamRole)
    : 'member';
}
