import { Inject, Injectable } from '@nestjs/common';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.tokens';

export type AuditAction = 'user.ban' | 'user.unban' | 'user.impersonate';

export interface AuditEntry {
  actorUid: string;
  action: AuditAction;
  targetUid: string;
  meta?: Record<string, string | number | boolean | null>;
}

/**
 * `auditLog/{id}`. Entries are written as `pending` before the action and
 * marked `applied` or `failed` after, so no admin action goes unrecorded.
 */
export abstract class AuditLogRepository {
  abstract begin(entry: AuditEntry): Promise<string>;
  /** `completed` lists the steps that ran, so a partial failure is visible. */
  abstract finish(
    id: string,
    status: 'applied' | 'failed',
    details?: { error?: string; completed?: string[] },
  ): Promise<void>;
}

@Injectable()
export class FirestoreAuditLogRepository extends AuditLogRepository {
  constructor(@Inject(FIRESTORE) private readonly db: Firestore) {
    super();
  }

  async begin(entry: AuditEntry): Promise<string> {
    const ref = await this.db.collection('auditLog').add({
      ...entry,
      meta: entry.meta ?? {},
      status: 'pending',
      at: FieldValue.serverTimestamp(),
    });
    return ref.id;
  }

  async finish(
    id: string,
    status: 'applied' | 'failed',
    details: { error?: string; completed?: string[] } = {},
  ): Promise<void> {
    await this.db
      .collection('auditLog')
      .doc(id)
      .update({
        status,
        ...(details.error && { error: details.error }),
        ...(details.completed && { completed: details.completed }),
        finishedAt: FieldValue.serverTimestamp(),
      });
  }
}
