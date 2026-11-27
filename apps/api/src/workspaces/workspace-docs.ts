import { FieldValue } from 'firebase-admin/firestore';

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
