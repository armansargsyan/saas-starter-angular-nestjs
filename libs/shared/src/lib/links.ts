import { z } from 'zod';

/** Length of generated short codes (base62). */
export const SHORT_CODE_LENGTH = 7;

/** Custom slugs: 3–32 chars of `a-z`, `0-9` and `-`, not starting or ending with `-`. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

/** Slugs that could be confused with app routes or abused for phishing. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'about',
  'account',
  'admin',
  'api',
  'app',
  'auth',
  'billing',
  'dashboard',
  'help',
  'login',
  'logout',
  'pricing',
  'r',
  'register',
  'security',
  'settings',
  'signin',
  'signup',
  'support',
  'team',
  'teams',
  'www',
]);

export const MAX_URL_LENGTH = 2048;
export const MAX_TITLE_LENGTH = 200;

/**
 * Target URLs are stored normalized (`new URL(...).href`), so what we
 * validate is exactly what we redirect to. Userinfo (`https://bank.com@evil.com`)
 * is refused: it only exists to disguise the real host.
 */
const targetUrl = z
  .string()
  .trim()
  .max(MAX_URL_LENGTH, `must be at most ${MAX_URL_LENGTH} characters`)
  .refine(isHttpUrl, { message: 'must be an http(s) URL' })
  .refine((value) => !hasUserinfo(value), {
    message: 'must not contain a username or password',
  })
  .transform((value) => new URL(value).href)
  .refine((href) => href.length <= MAX_URL_LENGTH, {
    message: `must be at most ${MAX_URL_LENGTH} characters`,
  });

const title = z
  .string()
  .trim()
  .max(MAX_TITLE_LENGTH, `must be at most ${MAX_TITLE_LENGTH} characters`);

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SLUG_PATTERN, 'must be 3–32 characters of a-z, 0-9 and -')
  .refine((value) => !RESERVED_SLUGS.has(value), {
    message: 'is reserved',
  });

/** Body of `POST /api/workspaces/:workspaceId/links`. */
export const createLinkSchema = z.strictObject({
  targetUrl,
  title: title.optional(),
  /** Custom short code; a random one is generated when omitted. */
  slug: slug.optional(),
});
export type CreateLinkRequest = z.input<typeof createLinkSchema>;

/** Body of `PATCH /api/links/:code`. The code itself can't change. */
export const updateLinkSchema = z
  .strictObject({ targetUrl: targetUrl.optional(), title: title.optional() })
  .refine((body) => body.targetUrl !== undefined || body.title !== undefined, {
    message: 'nothing to update',
  });
export type UpdateLinkRequest = z.input<typeof updateLinkSchema>;

export const LINK_STATS_MAX_DAYS = 90;

/** Query of `GET /api/links/:code/stats`. */
export const linkStatsQuerySchema = z.strictObject({
  days: z.coerce.number().int().min(1).max(LINK_STATS_MAX_DAYS).default(30),
});

/** Short codes as they can appear in a URL: random base62 or a custom slug. */
export const SHORT_CODE_PATTERN = /^[A-Za-z0-9-]{3,32}$/;

/**
 * Workspace ids: a Firebase uid (personal) or a generated id (team).
 * Checked before they reach Firestore, which rejects `/` and `__x__` ids.
 */
export const workspaceIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, 'is not a valid workspace id')
  .refine((id) => !/^__.*__$/.test(id), {
    message: 'is not a valid workspace id',
  });

export const LINK_LIST_MAX_LIMIT = 100;

/** Query of `GET /api/workspaces/:workspaceId/links`. */
export const listLinksQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(LINK_LIST_MAX_LIMIT).default(50),
  /** `nextCursor` from the previous page. */
  cursor: z
    .string()
    .regex(SHORT_CODE_PATTERN, 'is not a valid cursor')
    .optional(),
});

export interface Link {
  code: string;
  shortUrl: string;
  workspaceId: string;
  targetUrl: string;
  title: string | null;
  createdBy: string;
  createdAt: string;
  /** Human clicks; bots are counted separately. */
  clickCount: number;
  lastClickedAt: string | null;
}

export interface LinkListResponse {
  items: Link[];
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
}

export type DeviceType = 'mobile' | 'desktop' | 'bot';

export interface LinkStatsResponse {
  code: string;
  /** One entry per UTC day, oldest first, including days with no clicks. */
  days: { date: string; count: number }[];
  totalClicks: number;
  botClicks: number;
  topReferrers: { host: string; count: number }[];
  topCountries: { country: string; count: number }[];
  devices: { mobile: number; desktop: number };
}

function hasUserinfo(value: string): boolean {
  try {
    const url = new URL(value);
    return url.username !== '' || url.password !== '';
  } catch {
    return false; // Not a URL at all: reported by isHttpUrl.
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname !== ''
    );
  } catch {
    return false;
  }
}
