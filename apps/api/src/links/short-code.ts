import { randomInt } from 'node:crypto';
import { SHORT_CODE_LENGTH } from '@saas-starter/shared';

const ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** A random base62 code (62^7 ≈ 3.5e12), from a CSPRNG so codes aren't guessable. */
export function generateShortCode(length = SHORT_CODE_LENGTH): string {
  let code = '';
  for (let i = 0; i < length; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** Shape check for the `:code` route param, before touching Firestore. */
export function isPlausibleCode(code: string): boolean {
  return /^[A-Za-z0-9-]{3,32}$/.test(code);
}
