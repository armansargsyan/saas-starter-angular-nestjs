import { describe, expect, it } from 'vitest';
import { initialsOf, updateProfileSchema } from './account';

describe('updateProfileSchema', () => {
  it('trims the name and normalizes the avatar URL', () => {
    expect(
      updateProfileSchema.parse({
        displayName: '  Ada Lovelace ',
        photoURL: ' https://Example.com/a b.png ',
      }),
    ).toEqual({
      displayName: 'Ada Lovelace',
      photoURL: 'https://example.com/a%20b.png',
    });
  });

  it('turns empty values into null (clears them)', () => {
    expect(
      updateProfileSchema.parse({ displayName: ' ', photoURL: '' }),
    ).toEqual({ displayName: null, photoURL: null });
  });

  it('keeps ordinary non-ASCII names', () => {
    expect(
      updateProfileSchema.parse({ displayName: 'Zoë Ñúñez 李雷 مريم' }),
    ).toEqual({ displayName: 'Zoë Ñúñez 李雷 مريم' });
  });

  it('accepts a single field', () => {
    expect(updateProfileSchema.parse({ displayName: 'Ada' })).toEqual({
      displayName: 'Ada',
    });
  });

  it.each([
    {},
    { displayName: 'a'.repeat(81) },
    { displayName: 'line\nbreak' },
    { displayName: 'c1\u0085control' },
    { displayName: 'c1\u009bcontrol' },
    { displayName: 'evil\u202egnp.exe' },
    { displayName: 'iso\u2066late\u2069' },
    { displayName: 'line\u2028sep' },
    { displayName: 'para\u2029sep' },
    { photoURL: 'http://example.com/a.png' },
    { photoURL: 'javascript:alert(1)' },
    { photoURL: 'data:image/png;base64,AAAA' },
    { photoURL: 'https://user:pw@example.com/a.png' },
    { photoURL: `https://example.com/${'a'.repeat(2048)}` },
    { photoURL: 'not a url' },
    { displayName: 'Ada', email: 'x@example.com' },
    { displayName: 42 },
  ])('rejects %j', (body) => {
    expect(updateProfileSchema.safeParse(body).success).toBe(false);
  });
});

describe('initialsOf', () => {
  it.each([
    ['Ada Lovelace', 'a@example.com', 'AL'],
    ['ada', null, 'A'],
    ['  Grace  Brewster  Hopper ', null, 'GH'],
    [null, 'zed@example.com', 'Z'],
    ['', '', '?'],
    [null, null, '?'],
    ['élodie', null, 'É'],
  ])('%j / %j → %s', (name, email, expected) => {
    expect(initialsOf(name, email)).toBe(expected);
  });
});
