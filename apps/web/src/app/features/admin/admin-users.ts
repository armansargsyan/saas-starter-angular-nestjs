import { DatePipe, DecimalPipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  linkedSignal,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBan,
  lucideEye,
  lucideSearch,
  lucideUserCheck,
  lucideX,
} from '@ng-icons/lucide';
import {
  type AdminUser,
  type AdminUserListResponse,
  IMPERSONATION_MAX_MINUTES,
  PLANS,
} from '@saas-starter/shared';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmAlertDialogImports } from '@spartan-ng/helm/alert-dialog';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSkeletonImports } from '@spartan-ng/helm/skeleton';
import { AuthService } from '../../core/auth.service';
import { AdminApi } from './admin.api';

const PAGE_SIZE = 25;

/**
 * Users, searchable by email prefix and paged by cursor, with ban/unban and
 * impersonate (each confirmed first). The api decides who may be acted on:
 * the UI hides actions on admins and on yourself, the api refuses them too.
 */
@Component({
  selector: 'app-admin-users',
  imports: [
    DatePipe,
    DecimalPipe,
    NgIcon,
    HlmAlertImports,
    HlmAlertDialogImports,
    HlmBadgeImports,
    HlmButtonImports,
    HlmInputImports,
    HlmSkeletonImports,
  ],
  providers: [
    provideIcons({
      lucideBan,
      lucideEye,
      lucideSearch,
      lucideUserCheck,
      lucideX,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-users.html',
})
export class AdminUsers {
  private readonly api = inject(AdminApi);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** The applied search (an email prefix) and what's typed in the box. */
  protected readonly query = signal('');
  protected readonly draft = signal('');
  /** Cursors of the pages before this one: `[]` is the first page. */
  protected readonly cursors = signal<string[]>([]);

  protected readonly users = httpResource<AdminUserListResponse>(() => {
    const q = this.query();
    const cursor = this.cursors().at(-1);
    return {
      url: '/api/admin/users',
      params: {
        limit: PAGE_SIZE,
        ...(q && { q }),
        ...(cursor && { cursor }),
      },
    };
  });
  /** `value()` throws while the resource is in an error state. */
  protected readonly rows = computed<AdminUser[]>(() =>
    this.users.hasValue() ? this.users.value().items : [],
  );
  protected readonly nextCursor = computed(() =>
    this.users.hasValue() ? this.users.value().nextCursor : null,
  );
  protected readonly page = computed(() => this.cursors().length + 1);
  /** Whether a next page existed, kept while the next request loads (the pager stays). */
  protected readonly hasNext = linkedSignal<string | null | undefined, boolean>(
    {
      source: () =>
        this.users.hasValue() ? this.users.value().nextCursor : undefined,
      computation: (next, previous) =>
        next === undefined ? (previous?.value ?? false) : next !== null,
    },
  );

  protected readonly me = computed(() => this.auth.user()?.uid ?? null);
  protected readonly plans = PLANS;
  protected readonly maxMinutes = IMPERSONATION_MAX_MINUTES;

  protected readonly busy = signal<string | null>(null);
  /** Visible failures, dismissible. */
  protected readonly notice = signal<string | null>(null);
  /** Screen-reader announcements (successes). */
  protected readonly announcement = signal('');

  /** Admins and yourself are protected (the api refuses those too). */
  protected actionable(user: AdminUser): boolean {
    return user.role !== 'admin' && user.uid !== this.me();
  }

  protected name(user: AdminUser): string {
    return user.email ?? user.displayName ?? user.uid;
  }

  protected onDraft(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  protected search(event: Event): void {
    event.preventDefault();
    this.apply(this.draft().trim());
  }

  protected clear(): void {
    this.draft.set('');
    this.apply('');
    this.focus('#user-search');
  }

  protected next(): void {
    const cursor = this.nextCursor();
    if (cursor && !this.users.isLoading()) {
      this.cursors.update((list) => [...list, cursor]);
    }
  }

  protected previous(): void {
    if (this.page() > 1 && !this.users.isLoading()) {
      this.cursors.update((list) => list.slice(0, -1));
    }
  }

  protected async setBanned(
    user: AdminUser,
    banned: boolean,
    close: () => void,
  ): Promise<void> {
    if (this.busy()) return;
    this.busy.set(user.uid);
    const result = banned
      ? await this.api.ban(user.uid)
      : await this.api.unban(user.uid);
    this.busy.set(null);
    close();
    if (!result.ok) {
      this.notice.set(
        `Couldn’t ${banned ? 'ban' : 'unban'} ${this.name(user)}: ${result.error.message}`,
      );
      return;
    }
    const updated = result.value;
    this.users.update((page) =>
      page
        ? {
            ...page,
            items: page.items.map((u) => (u.uid === updated.uid ? updated : u)),
          }
        : page,
    );
    this.announcement.set(
      `${this.name(user)} is ${banned ? 'banned' : 'active again'}.`,
    );
    // The button that opened the dialog is gone: focus its replacement.
    this.focusAction(user.uid, banned ? 'unban' : 'ban');
  }

  /**
   * Signs in as the user with the api's custom token. This replaces the
   * admin's session (Firebase keeps one per browser).
   */
  protected async impersonate(
    user: AdminUser,
    close: () => void,
  ): Promise<void> {
    if (this.busy()) return;
    this.busy.set(user.uid);
    const result = await this.api.impersonate(user.uid);
    if (!result.ok) {
      this.busy.set(null);
      close();
      this.notice.set(
        `Couldn’t impersonate ${this.name(user)}: ${result.error.message}`,
      );
      return;
    }
    const adminUid = this.me();
    try {
      await this.auth.signInWithCustomToken(result.value.customToken);
    } catch {
      this.busy.set(null);
      close();
      if (!this.auth.signedIn()) {
        // The failure signed the admin out: every retry here would 401.
        await this.router.navigateByUrl(
          '/login?redirect=%2Fadmin&reason=impersonation-failed',
        );
      } else if (this.me() !== adminUid) {
        // Signed in as the user after all (marked read-only): go on.
        await this.router.navigateByUrl('/dashboard');
      } else {
        this.notice.set(
          `Couldn’t sign in as ${this.name(user)}. Please try again.`,
        );
      }
      return;
    }
    this.busy.set(null);
    close();
    await this.router.navigateByUrl('/dashboard');
  }

  private apply(query: string): void {
    this.notice.set(null);
    this.query.set(query);
    this.cursors.set([]);
  }

  private focusAction(uid: string, action: 'ban' | 'unban'): void {
    afterNextRender(
      () => {
        const row = [
          ...this.host.nativeElement.querySelectorAll<HTMLElement>(
            '[data-user]',
          ),
        ].find((el) => el.dataset['user'] === uid);
        row?.querySelector<HTMLElement>(`[data-action="${action}"]`)?.focus();
      },
      { injector: this.injector },
    );
  }

  private focus(selector: string): void {
    afterNextRender(
      () =>
        this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(),
      { injector: this.injector },
    );
  }
}
