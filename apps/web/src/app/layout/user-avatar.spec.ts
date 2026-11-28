import { TestBed } from '@angular/core/testing';
import { UserAvatar } from './user-avatar';

describe('UserAvatar', () => {
  async function render(inputs: Record<string, unknown>) {
    const fixture = TestBed.createComponent(UserAvatar);
    for (const [key, value] of Object.entries(inputs)) {
      fixture.componentRef.setInput(key, value);
    }
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    return {
      fixture,
      img: () => el.querySelector<HTMLImageElement>('img'),
      initials: () =>
        el
          .querySelector('[data-testid="avatar-initials"]')
          ?.textContent?.trim() ?? null,
    };
  }

  it('shows initials without a picture', async () => {
    const { img, initials } = await render({
      displayName: 'Ada Lovelace',
      email: 'a@example.com',
    });
    expect(img()).toBeNull();
    expect(initials()).toBe('AL');
  });

  it('keeps the initials until the picture has loaded, then shows only it', async () => {
    const { fixture, img, initials } = await render({
      displayName: 'Ada',
      photoURL: 'https://example.com/a.png',
    });
    expect(img()?.getAttribute('src')).toBe('https://example.com/a.png');
    expect(img()?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(img()?.classList).toContain('invisible');
    expect(initials()).toBe('A');

    img()?.dispatchEvent(new Event('load'));
    await fixture.whenStable();
    expect(img()?.classList).not.toContain('invisible');
    expect(initials()).toBeNull();
  });

  it('falls back to initials when the picture fails, and starts over for a new URL', async () => {
    const { fixture, img, initials } = await render({
      displayName: 'Ada',
      photoURL: 'https://example.com/broken.png',
    });
    img()?.dispatchEvent(new Event('error'));
    await fixture.whenStable();
    expect(initials()).toBe('A');
    expect(img()?.classList).toContain('invisible');

    fixture.componentRef.setInput('photoURL', 'https://example.com/ok.png');
    await fixture.whenStable();
    img()?.dispatchEvent(new Event('load'));
    await fixture.whenStable();
    expect(initials()).toBeNull();
  });

  it('never loads a non-https picture', async () => {
    const { img, initials } = await render({
      email: 'zed@example.com',
      photoURL: 'http://example.com/a.png',
    });
    expect(img()).toBeNull();
    expect(initials()).toBe('Z');
  });
});
