import { Inject, Injectable } from '@nestjs/common';
import {
  PLAN_IDS,
  PLAN_STATUSES,
  type PlanId,
  type PlanStatus,
  type WorkspacePlan,
} from '@saas-starter/shared';
import { type Firestore, Timestamp } from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.tokens';

export abstract class WorkspacesRepository {
  /** `workspaces/{id}.plan`, or null when the workspace or plan is absent. */
  abstract getPlan(workspaceId: string): Promise<WorkspacePlan | null>;
  /** Whether `uid` is in `workspaces/{id}/members` (team workspaces). */
  abstract isMember(workspaceId: string, uid: string): Promise<boolean>;
}

@Injectable()
export class FirestoreWorkspacesRepository extends WorkspacesRepository {
  constructor(@Inject(FIRESTORE) private readonly db: Firestore) {
    super();
  }

  async getPlan(workspaceId: string): Promise<WorkspacePlan | null> {
    const snap = await this.db.collection('workspaces').doc(workspaceId).get();
    return toWorkspacePlan(snap.get('plan'));
  }

  async isMember(workspaceId: string, uid: string): Promise<boolean> {
    const snap = await this.db
      .collection('workspaces')
      .doc(workspaceId)
      .collection('members')
      .doc(uid)
      .get();
    return snap.exists;
  }
}

/** Parses a stored plan; anything malformed is treated as no plan (Free). */
export function toWorkspacePlan(raw: unknown): WorkspacePlan | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const plan = raw as Record<string, unknown>;
  const id = plan['id'] as PlanId;
  const status = plan['status'] as PlanStatus;
  if (
    !(PLAN_IDS as readonly unknown[]).includes(id) ||
    !(PLAN_STATUSES as readonly unknown[]).includes(status)
  ) {
    return null;
  }

  const end = plan['currentPeriodEnd'];
  return {
    id,
    status,
    currentPeriodEnd:
      end instanceof Timestamp
        ? end.toDate().toISOString()
        : typeof end === 'string'
          ? end
          : null,
    cancelAtPeriodEnd: plan['cancelAtPeriodEnd'] === true,
  };
}
