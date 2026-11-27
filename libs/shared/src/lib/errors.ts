import type { PlanId } from './plans';

/**
 * Machine-readable `code`s in api error bodies (`{ statusCode, code, message }`),
 * so the web app can react without parsing messages.
 */
export const API_ERROR_CODES = [
  /** 403: the workspace's plan limit is reached; upgrade or delete some. */
  'plan_limit_reached',
  /** 409: the custom short code is taken (or retired). */
  'slug_taken',
  /** 400: the target URL points back at this app. */
  'self_link',
  /** 409: the workspace already has a paid subscription; use the portal. */
  'already_subscribed',
  /** 409: no Stripe customer yet (nothing bought), so no portal or invoices. */
  'no_billing_account',
  /** 400: the plan doesn't fit the workspace (Pro: personal, Team: team). */
  'plan_not_available',
  /** 404: the invite doesn't exist, was revoked or already used. */
  'invite_invalid',
  /** 410: the invite expired. */
  'invite_expired',
  /** 403: the invite is for another email address. */
  'invite_email_mismatch',
  /** 403: your email must be verified to accept an invite. */
  'email_not_verified',
  /** 409: already a member of this team. */
  'already_member',
  /** 403: impersonated sessions are read-only. */
  'impersonation_read_only',
  /** 403: admins can't be banned or impersonated (and you can't target yourself). */
  'admin_protected',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody<C extends ApiErrorCode = ApiErrorCode> {
  statusCode: number;
  code: C;
  message: string;
}

/** Body of a `plan_limit_reached` 403. */
export interface PlanLimitErrorBody extends ApiErrorBody<'plan_limit_reached'> {
  statusCode: 403;
  resource: 'links' | 'members';
  limit: number;
  plan: PlanId;
}
