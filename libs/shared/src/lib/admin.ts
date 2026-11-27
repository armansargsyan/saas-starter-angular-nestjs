import { z } from 'zod';
import type { Role } from './auth';
import type { PlanId } from './plans';

export type UserStatus = 'active' | 'banned';

/** Query of `GET /api/admin/users`. */
export const adminUsersQuerySchema = z.strictObject({
  /** Email prefix (case-insensitive). */
  q: z.string().trim().toLowerCase().max(254).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** `nextCursor` from the previous page (a uid). */
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/, 'is not a valid cursor')
    .optional(),
});

/** Query of `GET /api/admin/stats`. */
export const adminStatsQuerySchema = z.strictObject({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

export interface AdminUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: Role;
  status: UserStatus;
  /** Effective plan of the user's personal workspace. */
  plan: PlanId;
  linkCount: number;
  createdAt: string | null;
}

export interface AdminUserListResponse {
  items: AdminUser[];
  nextCursor: string | null;
}

export interface AdminStatsResponse {
  /**
   * Monthly recurring revenue per currency, in the smallest unit (cents), from
   * subscriptions being billed (active, past_due; trials aren't revenue yet).
   */
  mrr: { currency: string; amount: number }[];
  /** Subscriptions that grant a plan (active, trialing, past_due), by plan. */
  liveSubscriptions: { pro: number; team: number };
  /** One entry per UTC day, oldest first, including days without signups. */
  signupsPerDay: { date: string; count: number }[];
}

/** Response of `POST /api/admin/users/:uid/impersonate`. */
export interface ImpersonationResponse {
  /** Firebase custom token: sign in with `signInWithCustomToken`. */
  customToken: string;
  /** The impersonated session ends at this time (read-only until then). */
  expiresAt: string;
}

/** Impersonated sessions end this long after the token was minted (or after sign-in, if sooner). */
export const IMPERSONATION_MAX_MINUTES = 30;
