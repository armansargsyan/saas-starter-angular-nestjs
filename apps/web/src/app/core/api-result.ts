import { HttpErrorResponse } from '@angular/common/http';
import type { ApiErrorBody, PlanLimitErrorBody } from '@saas-starter/shared';
import { firstValueFrom, type Observable } from 'rxjs';

/** A failed api call, in terms the UI can show. */
export interface ApiError {
  status: number;
  code: ApiErrorBody['code'] | 'validation' | 'unknown';
  message: string;
  /** Field-level messages from a 400 (`issues[].path` → message). */
  fields: Record<string, string>;
  /** Present for `plan_limit_reached`. */
  limit?: PlanLimitErrorBody;
}

export type ApiResult<T> =
  { ok: true; value: T } | { ok: false; error: ApiError };

/** Runs a request and turns failures into an `ApiError` (never throws). */
export async function apiResult<T>(
  request: Observable<T>,
): Promise<ApiResult<T>> {
  try {
    return { ok: true, value: await firstValueFrom(request) };
  } catch (err) {
    return { ok: false, error: toApiError(err) };
  }
}

const GENERIC = 'Something went wrong. Please try again.';

/**
 * Our api's 4xx messages are written for people, so they are shown as they
 * are; 5xx and network failures get a generic message.
 */
export function toApiError(err: unknown): ApiError {
  if (!(err instanceof HttpErrorResponse)) {
    return { status: 0, code: 'unknown', message: GENERIC, fields: {} };
  }
  const body = (
    typeof err.error === 'object' && err.error !== null ? err.error : {}
  ) as Partial<ApiErrorBody> & {
    issues?: { path: string; message: string }[];
  };
  const status = err.status;
  if (status === 400 && body.issues?.length) {
    const fields: Record<string, string> = {};
    for (const issue of body.issues) {
      fields[issue.path] ??= capitalize(issue.message);
    }
    return {
      status,
      code: 'validation',
      message: 'Please fix the highlighted fields.',
      fields,
    };
  }
  if (status === 429) {
    return {
      status,
      code: 'unknown',
      message: 'Too many requests. Wait a moment and try again.',
      fields: {},
    };
  }
  if (status >= 400 && status < 500 && typeof body.message === 'string') {
    return {
      status,
      code: body.code ?? 'unknown',
      message: body.message,
      fields: {},
      ...(body.code === 'plan_limit_reached' && {
        limit: body as PlanLimitErrorBody,
      }),
    };
  }
  return { status, code: 'unknown', message: GENERIC, fields: {} };
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
