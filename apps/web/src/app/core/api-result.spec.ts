import { HttpErrorResponse } from '@angular/common/http';
import { throwError, of } from 'rxjs';
import { apiResult, toApiError } from './api-result';

const httpError = (status: number, error: unknown) =>
  new HttpErrorResponse({ status, error });

describe('apiResult / toApiError', () => {
  it('wraps success and failure', async () => {
    expect(await apiResult(of(1))).toEqual({ ok: true, value: 1 });
    const failed = await apiResult(
      throwError(() =>
        httpError(404, { code: 'invite_invalid', message: 'Gone' }),
      ),
    );
    expect(failed).toMatchObject({
      ok: false,
      error: { status: 404, code: 'invite_invalid', message: 'Gone' },
    });
  });

  it('maps validation issues to fields', () => {
    expect(
      toApiError(
        httpError(400, {
          issues: [
            { path: 'email', message: 'must be an email address' },
            { path: 'email', message: 'second' },
          ],
        }),
      ),
    ).toEqual({
      status: 400,
      code: 'validation',
      message: 'Please fix the highlighted fields.',
      fields: { email: 'Must be an email address' },
    });
  });

  it('keeps the plan limit details', () => {
    const body = {
      statusCode: 403,
      code: 'plan_limit_reached',
      message: 'Your Free plan allows 1 member.',
      resource: 'members',
      limit: 1,
      plan: 'free',
    };
    expect(toApiError(httpError(403, body)).limit).toEqual(body);
  });

  it('keeps the teams that block an account deletion', () => {
    const teams = [{ id: 't1', name: 'Acme' }];
    expect(
      toApiError(
        httpError(409, {
          statusCode: 409,
          code: 'owns_team_with_members',
          message: 'You own a team…',
          teams,
        }),
      ).teams,
    ).toEqual(teams);
    expect(
      toApiError(
        httpError(409, { code: 'owns_team_with_members', message: 'x' }),
      ).teams,
    ).toEqual([]);
  });

  it('shows 4xx messages, but never 5xx or network details', () => {
    expect(toApiError(httpError(403, { message: 'Not allowed' })).message).toBe(
      'Not allowed',
    );
    expect(
      toApiError(httpError(500, { message: 'db exploded at line 3' })).message,
    ).toBe('Something went wrong. Please try again.');
    expect(toApiError(httpError(429, {})).message).toContain('Too many');
    expect(toApiError(new Error('offline')).code).toBe('unknown');
    expect(toApiError(httpError(404, 'Not Found')).message).toBe(
      'Something went wrong. Please try again.',
    );
  });
});
