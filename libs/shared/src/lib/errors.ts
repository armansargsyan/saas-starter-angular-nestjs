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
