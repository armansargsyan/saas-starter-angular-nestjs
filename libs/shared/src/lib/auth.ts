import type { PlanId } from './plans';

/** Global role, from the `role` Firebase custom claim. */
export type Role = 'user' | 'admin';

/** Response of `GET /api/auth/me`. */
export interface MeResponse {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  role: Role;
  /** Effective plan of the caller's personal workspace. */
  plan: PlanId;
}
