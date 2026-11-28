import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
} from '@angular/core';
import { initialsOf, isPlainHttpsUrl } from '@saas-starter/shared';
import { HlmAvatar } from '@spartan-ng/helm/avatar';

/**
 * The user's picture, or their initials while there's none, while it loads,
 * or when it fails to load. Decorative: the name is always shown or
 * announced next to it.
 */
@Component({
  selector: 'app-user-avatar',
  imports: [HlmAvatar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex' },
  template: `
    <!-- "lg" is enlarged here to a 64px profile picture. -->
    <span
      hlmAvatar
      [size]="size()"
      class="data-[size=lg]:size-16 data-[size=lg]:text-xl"
      aria-hidden="true"
    >
      @if (src(); as url) {
        <img
          [src]="url"
          alt=""
          referrerpolicy="no-referrer"
          class="absolute inset-0 size-full rounded-full object-cover"
          [class.invisible]="image() !== 'loaded'"
          (load)="image.set('loaded')"
          (error)="image.set('failed')"
          data-testid="avatar-image"
        />
      }
      @if (image() !== 'loaded') {
        <span
          class="bg-primary text-primary-foreground flex size-full items-center justify-center rounded-full text-sm font-medium group-data-[size=lg]/avatar:text-xl group-data-[size=sm]/avatar:text-xs"
          data-testid="avatar-initials"
          >{{ initials() }}</span
        >
      }
    </span>
  `,
})
export class UserAvatar {
  readonly photoURL = input<string | null | undefined>(null);
  readonly displayName = input<string | null | undefined>(null);
  readonly email = input<string | null | undefined>(null);
  readonly size = input<'sm' | 'default' | 'lg'>('default');

  /** Only https images: anything else (e.g. an old http URL) shows initials. */
  protected readonly src = computed(() => {
    const url = this.photoURL();
    return url && isPlainHttpsUrl(url) ? url : null;
  });
  /** Starts over for every new URL. */
  protected readonly image = linkedSignal<
    string | null,
    'loading' | 'loaded' | 'failed'
  >({
    source: this.src,
    computation: () => 'loading',
  });
  protected readonly initials = computed(() =>
    initialsOf(this.displayName(), this.email()),
  );
}
