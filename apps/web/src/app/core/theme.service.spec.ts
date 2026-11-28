import { TestBed } from '@angular/core/testing';
import { THEME_STORAGE_KEY, ThemeService } from './theme.service';

/** A controllable `(prefers-color-scheme: dark)` media query. */
function fakeMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mql = {
    matches,
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) =>
      listeners.add(cb),
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) =>
      listeners.delete(cb),
  };
  return {
    mql,
    listeners,
    change(next: boolean) {
      mql.matches = next;
      for (const cb of listeners) cb({ matches: next } as MediaQueryListEvent);
    },
  };
}

describe('ThemeService', () => {
  let media: ReturnType<typeof fakeMedia>;
  const html = () => document.documentElement;
  const isDark = () => html().classList.contains('dark');

  function create(systemDark = false) {
    media = fakeMedia(systemDark);
    vi.spyOn(window, 'matchMedia').mockReturnValue(
      media.mql as unknown as MediaQueryList,
    );
    return TestBed.inject(ThemeService);
  }

  beforeEach(() => {
    window.localStorage.clear();
    html().classList.remove('dark');
    // jsdom has no matchMedia: give the spy something to replace.
    window.matchMedia ??= (() => null) as unknown as typeof window.matchMedia;
  });

  afterEach(() => vi.restoreAllMocks());

  it('defaults to system and follows the OS, including live changes', () => {
    const theme = create(true);
    expect(theme.preference()).toBe('system');
    expect(isDark()).toBe(true);

    media.change(false);
    expect(theme.resolved()).toBe('light');
    expect(isDark()).toBe(false);
  });

  it('persists light or dark, and stops following the OS', () => {
    const theme = create(false);
    theme.set('dark');
    expect(isDark()).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    media.change(false);
    expect(isDark()).toBe(true);

    theme.set('light');
    media.change(true);
    expect(isDark()).toBe(false);
  });

  it('back to system clears the stored choice and follows the OS again', () => {
    const theme = create(true);
    theme.set('light');
    theme.set('system');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(isDark()).toBe(true);
  });

  it('starts from the stored choice and ignores junk', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(create(false).preference()).toBe('dark');
    expect(isDark()).toBe(true);

    TestBed.resetTestingModule();
    window.localStorage.setItem(THEME_STORAGE_KEY, 'purple');
    expect(create(false).preference()).toBe('system');
  });

  it('follows a change made in another tab', () => {
    const theme = create(false);
    // The other tab wrote it; this tab gets the event.
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    window.dispatchEvent(
      new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'dark' }),
    );
    expect(theme.preference()).toBe('dark');
    expect(isDark()).toBe(true);
  });

  it('falls back to system when another tab clears storage', () => {
    const theme = create(true);
    theme.set('light');
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(theme.preference()).toBe('system');
    expect(isDark()).toBe(true);
  });

  it('ignores changes to other keys', () => {
    const theme = create(false);
    theme.set('dark');
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'other', newValue: 'x' }),
    );
    expect(theme.preference()).toBe('dark');
  });

  it('keeps the theme-color metas in step with the chosen theme', () => {
    const metas = ['light', 'dark'].map((scheme) => {
      const meta = document.createElement('meta');
      meta.name = 'theme-color';
      meta.media = `(prefers-color-scheme: ${scheme})`;
      document.head.appendChild(meta);
      return meta;
    });
    try {
      const theme = create(false);
      expect(metas.map((m) => m.content)).toEqual(['#ffffff', '#ffffff']);
      theme.set('dark');
      expect(metas.map((m) => m.content)).toEqual(['#09090b', '#09090b']);
    } finally {
      metas.forEach((m) => m.remove());
    }
  });

  it('works when storage is blocked', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const theme = create(false);
    theme.set('dark');
    expect(theme.preference()).toBe('dark');
    expect(isDark()).toBe(true);
  });

  it('stops listening when destroyed', () => {
    create(false);
    expect(media.listeners.size).toBe(1);
    TestBed.resetTestingModule();
    expect(media.listeners.size).toBe(0);
  });
});
