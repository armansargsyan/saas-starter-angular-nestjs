import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  ApiErrorBody,
  CreateLinkRequest,
  Link,
  PlanLimitErrorBody,
  UpdateLinkRequest,
} from '@saas-starter/shared';
import { firstValueFrom } from 'rxjs';

/** A failed link mutation, in terms the UI can show. */
export interface LinkError {
  code: ApiErrorBody['code'] | 'validation' | 'not_found' | 'unknown';
  message: string;
  /** Field-level messages from a 400 (`issues[].path` → message). */
  fields: Partial<Record<'targetUrl' | 'title' | 'slug', string>>;
  /** Present for `plan_limit_reached`. */
  limit?: PlanLimitErrorBody;
}

export type LinkResult<T> =
  { ok: true; value: T } | { ok: false; error: LinkError };

/** Link mutations (reads use httpResource in the components). */
@Injectable({ providedIn: 'root' })
export class LinksApi {
  private readonly http = inject(HttpClient);

  create(
    workspaceId: string,
    body: CreateLinkRequest,
  ): Promise<LinkResult<Link>> {
    return this.run(
      this.http.post<Link>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/links`,
        body,
      ),
    );
  }

  update(code: string, body: UpdateLinkRequest): Promise<LinkResult<Link>> {
    return this.run(
      this.http.patch<Link>(`/api/links/${encodeURIComponent(code)}`, body),
    );
  }

  delete(code: string): Promise<LinkResult<null>> {
    return this.run(
      this.http.delete<null>(`/api/links/${encodeURIComponent(code)}`),
    );
  }

  private async run<T>(
    request: ReturnType<HttpClient['get']>,
  ): Promise<LinkResult<T>> {
    try {
      return { ok: true, value: (await firstValueFrom(request)) as T };
    } catch (err) {
      return { ok: false, error: toLinkError(err) };
    }
  }
}

export function toLinkError(err: unknown): LinkError {
  if (!(err instanceof HttpErrorResponse)) {
    return {
      code: 'unknown',
      message: 'Something went wrong. Please try again.',
      fields: {},
    };
  }
  const body = (err.error ?? {}) as Partial<ApiErrorBody> & {
    issues?: { path: string; message: string }[];
  };
  if (body.code === 'plan_limit_reached') {
    return {
      code: body.code,
      message: body.message ?? 'Plan limit reached.',
      fields: {},
      limit: body as PlanLimitErrorBody,
    };
  }
  if (body.code === 'slug_taken') {
    return {
      code: body.code,
      message: 'That short code is taken.',
      fields: { slug: 'That short code is taken.' },
    };
  }
  if (body.code === 'self_link') {
    return {
      code: body.code,
      message: 'Links to this site aren’t allowed.',
      fields: { targetUrl: 'Links to this site aren’t allowed.' },
    };
  }
  if (err.status === 400 && body.issues) {
    const fields: LinkError['fields'] = {};
    for (const issue of body.issues) {
      if (
        issue.path === 'targetUrl' ||
        issue.path === 'title' ||
        issue.path === 'slug'
      ) {
        fields[issue.path] ??= capitalize(issue.message);
      }
    }
    return {
      code: 'validation',
      message: 'Please fix the highlighted fields.',
      fields,
    };
  }
  if (err.status === 404) {
    return {
      code: 'not_found',
      message: 'This link no longer exists.',
      fields: {},
    };
  }
  if (err.status === 429) {
    return {
      code: 'unknown',
      message: 'You’re creating links too fast. Wait a moment.',
      fields: {},
    };
  }
  return {
    code: 'unknown',
    message: 'Something went wrong. Please try again.',
    fields: {},
  };
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
