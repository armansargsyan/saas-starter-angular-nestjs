import { DatePipe, DecimalPipe } from '@angular/common';
import { HttpClient, httpResource } from '@angular/common/http';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  linkedSignal,
  Injector,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChartColumn,
  lucideCopy,
  lucidePencil,
  lucidePlus,
  lucideTrash2,
  lucideX,
} from '@ng-icons/lucide';
import type {
  Link,
  LinkListResponse,
  UsageResponse,
} from '@saas-starter/shared';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmAlertDialogImports } from '@spartan-ng/helm/alert-dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSkeletonImports } from '@spartan-ng/helm/skeleton';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { LinksApi } from '../../core/links.api';
import { WorkspaceService } from '../../core/workspace.service';
import { LinkFormDialog } from './link-form-dialog';
import { UsageMeter } from './usage-meter';

const PAGE_SIZE = 50;

@Component({
  selector: 'app-dashboard-page',
  imports: [
    DatePipe,
    DecimalPipe,
    RouterLink,
    NgIcon,
    HlmAlertImports,
    HlmAlertDialogImports,
    HlmButtonImports,
    HlmCardImports,
    HlmInputImports,
    HlmSkeletonImports,
    LinkFormDialog,
    UsageMeter,
  ],
  providers: [
    provideIcons({
      lucideChartColumn,
      lucideCopy,
      lucidePencil,
      lucidePlus,
      lucideTrash2,
      lucideX,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard-page.html',
})
export class DashboardPage {
  private readonly http = inject(HttpClient);
  private readonly api = inject(LinksApi);
  private readonly workspaces = inject(WorkspaceService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly workspaceId = this.workspaces.workspaceId;
  protected readonly personal = this.workspaces.isPersonal;
  /** Impersonated sessions are read-only (the api enforces it too). */
  private readonly auth = inject(AuthService);
  protected readonly readOnly = computed(
    () => this.auth.impersonatedBy() !== null,
  );

  protected readonly links = httpResource<LinkListResponse>(() => {
    const ws = this.workspaceId();
    return ws
      ? `/api/workspaces/${encodeURIComponent(ws)}/links?limit=${PAGE_SIZE}`
      : undefined;
  });
  protected readonly usage = httpResource<UsageResponse>(() => {
    const ws = this.workspaceId();
    return ws ? `/api/usage?workspaceId=${encodeURIComponent(ws)}` : undefined;
  });

  /** `value()` throws while a resource is in an error state: read through these. */
  private readonly firstPage = computed(() =>
    this.links.hasValue() ? this.links.value() : undefined,
  );
  protected readonly usageValue = computed(() =>
    this.usage.hasValue() ? this.usage.value() : undefined,
  );

  /** Pages loaded with "Load more", after the first (from the resource). */
  private readonly morePages = linkedSignal<string | null, LinkListResponse[]>({
    // A different workspace starts over at its first page.
    source: this.workspaceId,
    computation: () => [],
  });
  /** Bumped on every refresh, so a "Load more" response from before is dropped. */
  private generation = 0;
  protected readonly allLinks = computed<Link[]>(() => {
    const seen = new Set<string>();
    return [
      ...(this.firstPage()?.items ?? []),
      ...this.morePages().flatMap((page) => page.items),
    ].filter((link) => !seen.has(link.code) && seen.add(link.code));
  });
  protected readonly nextCursor = computed(() => {
    const pages = this.morePages();
    return pages.length
      ? pages[pages.length - 1].nextCursor
      : (this.firstPage()?.nextCursor ?? null);
  });
  protected readonly loadingMore = signal(false);

  protected readonly query = signal('');
  protected readonly visible = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.allLinks();
    return this.allLinks().filter((link) =>
      [link.code, link.targetUrl, link.title ?? ''].some((text) =>
        text.toLowerCase().includes(q),
      ),
    );
  });

  protected readonly dialogOpen = signal(false);
  protected readonly editing = signal<Link | null>(null);
  /** Screen-reader announcements (successes). */
  protected readonly announcement = signal('');
  /** Visible failures, dismissible. */
  protected readonly notice = signal<string | null>(null);
  protected readonly deleting = signal<string | null>(null);

  protected onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected openCreate(): void {
    this.editing.set(null);
    this.dialogOpen.set(true);
  }

  protected openEdit(link: Link): void {
    this.editing.set(link);
    this.dialogOpen.set(true);
  }

  protected onSaved(link: Link): void {
    const wasEditing = !!this.editing();
    this.dialogOpen.set(false);
    this.notice.set(null);
    if (wasEditing) {
      // Update in place, so a link from a later page doesn't vanish.
      this.morePages.update((pages) =>
        pages.map((page) => ({
          ...page,
          items: page.items.map((item) =>
            item.code === link.code ? link : item,
          ),
        })),
      );
      this.links.reload();
      this.announcement.set(`Saved ${link.code}.`);
    } else {
      this.announcement.set(`Created ${link.shortUrl}.`);
      this.refresh();
    }
  }

  protected async copy(link: Link): Promise<void> {
    try {
      await navigator.clipboard.writeText(link.shortUrl);
      this.announcement.set(`Copied ${link.shortUrl}`);
    } catch {
      this.notice.set(
        `Couldn’t copy. Select ${link.shortUrl} and copy it manually.`,
      );
    }
  }

  protected async remove(link: Link, close: () => void): Promise<void> {
    if (this.deleting()) return;
    this.deleting.set(link.code);
    const result = await this.api.delete(link.code);
    this.deleting.set(null);
    close();
    // Already gone (e.g. deleted in another tab) is what the user wanted.
    if (result.ok || result.error.code === 'not_found') {
      this.notice.set(null);
      this.announcement.set(`Deleted ${link.code}.`);
    } else {
      this.notice.set(`Couldn’t delete ${link.code}: ${result.error.message}`);
    }
    this.refresh();
    // The row (and the button that had focus) is gone: land somewhere useful.
    afterNextRender(
      () =>
        this.host.nativeElement
          .querySelector<HTMLElement>('#link-search')
          ?.focus(),
      { injector: this.injector },
    );
  }

  protected async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    const ws = this.workspaceId();
    if (!cursor || !ws || this.loadingMore()) return;
    const generation = this.generation;
    this.loadingMore.set(true);
    try {
      const page = await firstValueFrom(
        this.http.get<LinkListResponse>(
          `/api/workspaces/${encodeURIComponent(ws)}/links`,
          { params: { limit: PAGE_SIZE, cursor } },
        ),
      );
      if (generation === this.generation && ws === this.workspaceId()) {
        this.morePages.update((pages) => [...pages, page]);
      }
    } catch {
      if (generation === this.generation) {
        this.notice.set('Couldn’t load more links. Please try again.');
      }
    } finally {
      this.loadingMore.set(false);
    }
  }

  /** The dialog hit the plan limit: the meter's count may be stale. */
  protected onLimitReached(): void {
    this.usage.reload();
  }

  private refresh(): void {
    this.generation++;
    this.morePages.set([]);
    this.links.reload();
    this.usage.reload();
  }
}
