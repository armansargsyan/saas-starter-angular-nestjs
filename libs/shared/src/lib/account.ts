import { z } from 'zod';
import type { ApiErrorBody } from './errors';

export const DISPLAY_NAME_MAX_LENGTH = 80;
export const AVATAR_URL_MAX_LENGTH = 2048;

/**
 * Characters that have no place in a name: C0/C1 controls (incl. newlines),
 * line/paragraph separators, and bidi overrides/isolates, which can make a
 * name display as something else (e.g. reversed text next to an email).
 */
const INVISIBLE_OR_CONTROL =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** Deleting the account needs a sign-in at most this many minutes old. */
export const RECENT_LOGIN_MAX_MINUTES = 5;

/** An empty name clears it (null): the UI then falls back to the email. */
const displayName = z
  .string()
  .trim()
  .max(
    DISPLAY_NAME_MAX_LENGTH,
    `must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`,
  )
  .refine((value) => !INVISIBLE_OR_CONTROL.test(value), {
    message: 'must not contain control or invisible formatting characters',
  })
  .transform((value) => value || null);

/**
 * Avatars are https image URLs (there's no upload: no Storage bucket). Only
 * https, so a page served over https never loads mixed content; no userinfo,
 * which only exists to disguise the host. Empty clears it.
 */
const photoURL = z
  .string()
  .trim()
  .max(
    AVATAR_URL_MAX_LENGTH,
    `must be at most ${AVATAR_URL_MAX_LENGTH} characters`,
  )
  .refine((value) => value === '' || isPlainHttpsUrl(value), {
    message: 'must be an https:// URL',
  })
  .transform((value) => (value ? new URL(value).href : null))
  .refine((href) => href === null || href.length <= AVATAR_URL_MAX_LENGTH, {
    message: `must be at most ${AVATAR_URL_MAX_LENGTH} characters`,
  });

/** Body of `PATCH /api/account/profile`: either field, or both. */
export const updateProfileSchema = z
  .strictObject({
    displayName: displayName.optional(),
    photoURL: photoURL.optional(),
  })
  .refine(
    (body) => body.displayName !== undefined || body.photoURL !== undefined,
    { message: 'nothing to update' },
  );
export type UpdateProfileRequest = z.input<typeof updateProfileSchema>;

/** Response of `PATCH /api/account/profile`. */
export interface ProfileResponse {
  displayName: string | null;
  photoURL: string | null;
}

/** Body of the 409 from `DELETE /api/account` while you own teams with members. */
export interface AccountDeletionBlockedBody extends ApiErrorBody<'owns_team_with_members'> {
  statusCode: 409;
  /** The teams to empty (remove the other members) first. */
  teams: { id: string; name: string }[];
}

/** Up to two initials for an avatar fallback, from the name or else the email. */
export function initialsOf(
  displayName: string | null | undefined,
  email: string | null | undefined,
): string {
  const words = (displayName ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length) {
    const first = [...words[0]][0] ?? '';
    const last =
      words.length > 1 ? ([...words[words.length - 1]][0] ?? '') : '';
    return (first + last).toLocaleUpperCase();
  }
  const local = (email ?? '').split('@')[0];
  return ([...local][0] ?? '?').toLocaleUpperCase();
}

export function isPlainHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname !== '' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}
