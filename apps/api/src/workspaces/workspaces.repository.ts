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

/** What `GET /api/usage` needs from `workspaces/{id}`. */
export interface WorkspaceUsageSnapshot {
  plan: WorkspacePlan | null;
  linkCount: number;
  /** null when the doc doesn't record it (e.g. not created yet). */
  memberCount: number | null;
}

export abstract class WorkspacesRepository {
  /** `workspaces/{id}.plan`, or null when the workspace or plan is absent. */
  abstract getPlan(workspaceId: string): Promise<WorkspacePlan | null>;
  /** Whether `uid` is in `workspaces/{id}/members` (team workspaces). */
  abstract isMember(workspaceId: string, uid: string): Promise<boolean>;
  /** Null when the workspace doc doesn't exist yet. */
  abstract getUsage(
    workspaceId: string,
  ): Promise<WorkspaceUsageSnapshot | null>;
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

  async getUsage(workspaceId: string): Promise<WorkspaceUsageSnapshot | null> {
    const snap = await this.db.collection('workspaces').doc(workspaceId).get();
    if (!snap.exists) return null;
    const count = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : null;
    return {
      plan: toWorkspacePlan(snap.get('plan')),
      linkCount: count(snap.get('linkCount')) ?? 0,
      memberCount: count(snap.get('memberCount')),
    };
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
