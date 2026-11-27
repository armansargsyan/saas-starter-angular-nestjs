import { HttpErrorResponse } from '@angular/common/http';
import { toLinkError } from './links.api';

const http = (status: number, error: unknown) =>
  new HttpErrorResponse({ status, error });

describe('toLinkError', () => {
  it('maps the plan limit with its details', () => {
    const body = {
      statusCode: 403,
      code: 'plan_limit_reached',
      message: 'Your Free plan allows 10 links.',
      resource: 'links',
      limit: 10,
      plan: 'free',
    };
    expect(toLinkError(http(403, body))).toMatchObject({
      code: 'plan_limit_reached',
      message: 'Your Free plan allows 10 links.',
      limit: { limit: 10, plan: 'free' },
    });
  });

  it('puts known errors on their field', () => {
    expect(toLinkError(http(409, { code: 'slug_taken' })).fields).toEqual({
      slug: 'That short code is taken.',
    });
    expect(
      toLinkError(http(400, { code: 'self_link' })).fields.targetUrl,
    ).toContain('aren’t allowed');
  });

  it('maps validation issues by path', () => {
    const err = toLinkError(
      http(400, {
        message: 'Validation failed',
        issues: [
          { path: 'targetUrl', message: 'must be an http(s) URL' },
          { path: 'other', message: 'ignored' },
        ],
      }),
    );
    expect(err).toMatchObject({
      code: 'validation',
      fields: { targetUrl: 'Must be an http(s) URL' },
    });
  });

  it('has messages for 404, 429 and anything else', () => {
    expect(toLinkError(http(404, {})).code).toBe('not_found');
    expect(toLinkError(http(429, {})).message).toContain('too fast');
    expect(toLinkError(new Error('x')).code).toBe('unknown');
  });
});
