import { FieldValue, Timestamp } from 'firebase-admin/firestore';

/** A new personal workspace (`workspaces/{uid}`), created lazily on first use. */
export function newPersonalWorkspace(ownerUid: string, linkCount = 0) {
  return {
    type: 'personal',
    name: 'Personal',
    ownerUid,
    plan: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    linkCount,
    memberCount: 1,
    createdAt: FieldValue.serverTimestamp(),
  };
}

/**
 * `workspaces/{id}.deletingAt`: set on a team while its owner's account is
 * being deleted, so nobody can join it or be invited to it any more. A lock
 * from an attempt that was given up on (e.g. Stripe was down and the owner
 * never retried) lapses after this long; a retry simply locks it again.
 */
export const DELETION_LOCK_MS = 15 * 60_000;

export function isDeletionLocked(deletingAt: unknown, now: Date): boolean {
  return (
    deletingAt instanceof Timestamp &&
    now.getTime() - deletingAt.toMillis() < DELETION_LOCK_MS
  );
}
