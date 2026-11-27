import {
  computed,
  DestroyRef,
  DOCUMENT,
  inject,
  Injectable,
  signal,
} from '@angular/core';

export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** Also read by the inline script in index.html, before first paint. */
export const THEME_STORAGE_KEY = 'saas-starter.theme';

/** Browser UI colour (`<meta name="theme-color">`) per theme: the background. */
export const THEME_COLORS = { light: '#ffffff', dark: '#09090b' } as const;

export const THEME_LABELS: Record<ThemePreference, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

/**
 * Light, dark or the OS setting ("system"), remembered on this device. The
 * inline script in index.html applies the stored choice before first paint;
 * this keeps the `.dark` class on <html> in step afterwards: on a change
 * here, in another tab, or of the OS setting while on "system".
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly view = this.document.defaultView;
  private readonly media =
    this.view?.matchMedia?.('(prefers-color-scheme: dark)') ?? null;

  private readonly systemDark = signal(this.media?.matches ?? false);
  private readonly pref = signal<ThemePreference>(this.read());

  readonly preference = this.pref.asReadonly();
  /** What is on screen now. */
  readonly resolved = computed<'light' | 'dark'>(() => {
    const pref = this.pref();
    if (pref !== 'system') return pref;
    return this.systemDark() ? 'dark' : 'light';
  });

  constructor() {
    const onSystemChange = (event: MediaQueryListEvent) => {
      this.systemDark.set(event.matches);
      this.apply();
    };
    // Another tab changed it, or cleared storage (key null).
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
      this.pref.set(this.read());
      this.apply();
    };
    this.media?.addEventListener('change', onSystemChange);
    this.view?.addEventListener('storage', onStorage);
    inject(DestroyRef).onDestroy(() => {
      this.media?.removeEventListener('change', onSystemChange);
      this.view?.removeEventListener('storage', onStorage);
    });
    this.apply();
  }

  set(preference: ThemePreference): void {
    this.pref.set(preference);
    try {
      // "system" is the default: no entry needed.
      if (preference === 'system') {
        this.view?.localStorage.removeItem(THEME_STORAGE_KEY);
      } else {
        this.view?.localStorage.setItem(THEME_STORAGE_KEY, preference);
      }
    } catch {
      // Storage blocked: the choice lasts for this page view.
    }
    this.apply();
  }

  private apply(): void {
    const root = this.document.documentElement;
    const theme = this.resolved();
    const dark = theme === 'dark';
    // The browser's UI follows the chosen theme, not just the OS (both metas,
    // whichever media query matches).
    for (const meta of this.document.querySelectorAll<HTMLMetaElement>(
      'meta[name="theme-color"]',
    )) {
      meta.content = THEME_COLORS[theme];
    }
    if (root.classList.contains('dark') === dark) return;
    // Switch at once: without this, elements with colour transitions
    // (buttons, inputs) fade over while the rest has already switched.
    const pause = this.document.createElement('style');
    pause.textContent = '*,*::before,*::after{transition:none!important}';
    this.document.head.appendChild(pause);
    root.classList.toggle('dark', dark);
    // Apply the new colours now, then let transitions back in.
    void this.view?.getComputedStyle(root).color;
    if (this.view?.requestAnimationFrame) {
      this.view.requestAnimationFrame(() => pause.remove());
    } else {
      pause.remove();
    }
  }

  private read(): ThemePreference {
    try {
      return parse(this.view?.localStorage.getItem(THEME_STORAGE_KEY));
    } catch {
      return 'system';
    }
  }
}

function parse(value: string | null | undefined): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}
