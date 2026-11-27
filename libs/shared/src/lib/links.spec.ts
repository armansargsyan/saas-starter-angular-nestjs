import { describe, expect, it } from 'vitest';
import {
  createLinkSchema,
  linkStatsQuerySchema,
  listLinksQuerySchema,
  updateLinkSchema,
  workspaceIdSchema,
} from './links';

const ok = (body: unknown) => createLinkSchema.safeParse(body).success;

describe('createLinkSchema', () => {
  it.each([
    'https://example.com',
    'http://example.com/a?b=c#d',
    '  https://example.com/trim  ',
  ])('accepts %s', (targetUrl) => {
    expect(ok({ targetUrl })).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,hi',
    'ftp://example.com',
    'mailto:a@example.com',
    'example.com',
    '',
    'https://',
    `https://example.com/${'a'.repeat(2048)}`,
  ])('rejects the target %j', (targetUrl) => {
    expect(ok({ targetUrl })).toBe(false);
  });

  it('stores the normalized URL, so what is validated is what is redirected to', () => {
    const parse = (targetUrl: string) =>
      createLinkSchema.parse({ targetUrl }).targetUrl;
    expect(parse('HTTPS://Example.COM')).toBe('https://example.com/');
    // The WHATWG parser drops tabs and newlines and treats a backslash as /.
    expect(parse('https://exa\tmple.com\\path')).toBe(
      'https://example.com/path',
    );
  });

  it.each(['https://bank.com@evil.com/', 'https://user:pass@example.com'])(
    'rejects userinfo in %s',
    (targetUrl) => {
      expect(ok({ targetUrl })).toBe(false);
    },
  );

  it('normalizes a custom slug to lowercase', () => {
    const parsed = createLinkSchema.parse({
      targetUrl: 'https://example.com',
      slug: ' My-Link ',
    });
    expect(parsed.slug).toBe('my-link');
  });

  it.each(['ab', 'a'.repeat(33), '-abc', 'abc-', 'a_b', 'a b', 'ünï'])(
    'rejects the slug %j',
    (slug) => {
      expect(ok({ targetUrl: 'https://example.com', slug })).toBe(false);
    },
  );

  it.each(['admin', 'API', 'login'])('rejects the reserved slug %s', (slug) => {
    expect(ok({ targetUrl: 'https://example.com', slug })).toBe(false);
  });

  it('rejects unknown fields (e.g. a client-chosen workspace)', () => {
    expect(ok({ targetUrl: 'https://example.com', workspaceId: 'x' })).toBe(
      false,
    );
  });
});

describe('updateLinkSchema', () => {
  it('needs at least one field', () => {
    expect(updateLinkSchema.safeParse({}).success).toBe(false);
    expect(updateLinkSchema.safeParse({ title: 'New' }).success).toBe(true);
  });

  it('rejects changing the code', () => {
    expect(
      updateLinkSchema.safeParse({ code: 'abc', title: 'x' }).success,
    ).toBe(false);
  });
});

describe('workspaceIdSchema', () => {
  it.each(['abc', 'Koqhk63uvw6uMwCrm8YExhnz1qIV', 'team_1-x'])(
    'accepts %s',
    (id) => {
      expect(workspaceIdSchema.safeParse(id).success).toBe(true);
    },
  );

  it.each(['', 'a/b', '..', '__x__', 'a b', 'a'.repeat(129)])(
    'rejects %j',
    (id) => {
      expect(workspaceIdSchema.safeParse(id).success).toBe(false);
    },
  );
});

describe('query schemas', () => {
  it('defaults and bounds the stats window', () => {
    expect(linkStatsQuerySchema.parse({}).days).toBe(30);
    expect(linkStatsQuerySchema.parse({ days: '7' }).days).toBe(7);
    expect(linkStatsQuerySchema.safeParse({ days: '91' }).success).toBe(false);
  });

  it('defaults and bounds the list page size', () => {
    expect(listLinksQuerySchema.parse({}).limit).toBe(50);
    expect(listLinksQuerySchema.safeParse({ limit: '101' }).success).toBe(
      false,
    );
    expect(listLinksQuerySchema.safeParse({ cursor: 'a/b' }).success).toBe(
      false,
    );
  });
});
