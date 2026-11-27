import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  Injector,
  input,
  output,
  signal,
} from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  createLinkSchema,
  type Link,
  MAX_TITLE_LENGTH,
  MAX_URL_LENGTH,
  updateLinkSchema,
} from '@saas-starter/shared';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { type LinkError, LinksApi } from '../../core/links.api';
import { FormField } from '../auth/form-field';

type Field = 'targetUrl' | 'title' | 'slug';

/**
 * Create or edit a link. Validation runs the same zod schemas as the api
 * (libs/shared), and server errors (taken slug, self link, plan limit) are
 * shown on the right field.
 */
@Component({
  selector: 'app-link-form-dialog',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    HlmAlertImports,
    HlmButtonImports,
    HlmDialogImports,
    HlmInputImports,
    FormField,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="closed.emit()">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="sm:max-w-md">
        <hlm-dialog-header>
          <h2 hlmDialogTitle>
            {{ editing() ? 'Edit link' : 'New short link' }}
          </h2>
          <p hlmDialogDescription>
            @if (editing(); as link) {
              The short code <strong>{{ link.code }}</strong> stays the same.
            } @else {
              Paste a long URL. Pick a custom short code, or leave it empty for
              a random one.
            }
          </p>
        </hlm-dialog-header>

        <form
          class="grid gap-4"
          [formGroup]="form"
          (ngSubmit)="submit()"
          novalidate
        >
          <app-form-field
            for="link-target"
            label="Destination URL"
            [error]="error('targetUrl')"
          >
            <input
              hlmInput
              id="link-target"
              type="url"
              inputmode="url"
              placeholder="https://example.com/a/long/page"
              formControlName="targetUrl"
              [attr.maxlength]="maxUrl"
              [forceInvalid]="!!error('targetUrl')"
              [attr.aria-invalid]="error('targetUrl') ? 'true' : null"
              [attr.aria-describedby]="
                error('targetUrl') ? 'link-target-error' : null
              "
            />
          </app-form-field>
          @if (!editing()) {
            <app-form-field
              for="link-slug"
              label="Custom short code (optional)"
              [error]="error('slug')"
              hint="3–32 characters: a–z, 0–9 and -."
            >
              <input
                hlmInput
                id="link-slug"
                type="text"
                autocapitalize="none"
                spellcheck="false"
                formControlName="slug"
                maxlength="32"
                [forceInvalid]="!!error('slug')"
                [attr.aria-invalid]="error('slug') ? 'true' : null"
                [attr.aria-describedby]="
                  error('slug') ? 'link-slug-error' : 'link-slug-hint'
                "
              />
            </app-form-field>
          }
          <app-form-field
            for="link-title"
            label="Title (optional)"
            [error]="error('title')"
          >
            <input
              hlmInput
              id="link-title"
              type="text"
              formControlName="title"
              [attr.maxlength]="maxTitle"
              [forceInvalid]="!!error('title')"
              [attr.aria-invalid]="error('title') ? 'true' : null"
              [attr.aria-describedby]="
                error('title') ? 'link-title-error' : null
              "
            />
          </app-form-field>

          <div role="alert">
            @if (limitReached()) {
              <div hlmAlert data-testid="limit-in-dialog">
                <p hlmAlertDescription>
                  {{ serverError()?.message }}
                  <a
                    routerLink="/billing"
                    class="font-medium underline underline-offset-4"
                    >See plans</a
                  >
                </p>
              </div>
            } @else if (generalError()) {
              <div hlmAlert variant="destructive" data-testid="form-error">
                <p hlmAlertDescription>{{ generalError() }}</p>
              </div>
            }
          </div>

          <hlm-dialog-footer>
            <button
              hlmBtn
              variant="outline"
              type="button"
              (click)="ctx.close()"
            >
              Cancel
            </button>
            <button
              hlmBtn
              type="submit"
              class="aria-disabled:opacity-60"
              [attr.aria-disabled]="saving() ? 'true' : null"
              [attr.aria-busy]="saving()"
              data-testid="save"
            >
              {{
                saving()
                  ? 'Saving…'
                  : editing()
                    ? 'Save changes'
                    : 'Create link'
              }}
            </button>
          </hlm-dialog-footer>
        </form>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class LinkFormDialog {
  private readonly api = inject(LinksApi);
  private readonly injector = inject(Injector);

  readonly open = input(false);
  readonly workspaceId = input.required<string>();
  /** The link to edit; null creates a new one. */
  readonly editing = input<Link | null>(null);
  readonly saved = output<Link>();
  readonly closed = output<void>();
  /** A create was refused at the plan limit (the usage meter may be stale). */
  readonly planLimitHit = output<void>();

  protected readonly maxUrl = MAX_URL_LENGTH;
  protected readonly maxTitle = MAX_TITLE_LENGTH;
  protected readonly form = inject(NonNullableFormBuilder).group({
    targetUrl: [''],
    title: [''],
    slug: [''],
  });
  protected readonly saving = signal(false);
  private readonly clientErrors = signal<Partial<Record<Field, string>>>({});
  protected readonly serverError = signal<LinkError | null>(null);

  protected readonly limitReached = computed(
    () => this.serverError()?.code === 'plan_limit_reached',
  );
  /** Fields this form shows (the code can't change when editing). */
  private readonly visibleFields = computed<Field[]>(() =>
    this.editing() ? ['targetUrl', 'title'] : ['targetUrl', 'slug', 'title'],
  );
  /** The server's message, unless it was shown on a visible field. */
  protected readonly generalError = computed(() => {
    const err = this.serverError();
    if (!err || err.code === 'plan_limit_reached') return null;
    const onAField = this.visibleFields().some((field) => err.fields[field]);
    return onAField ? null : err.message;
  });

  constructor() {
    // Each opening starts from the link being edited (or an empty form).
    effect(() => {
      if (!this.open()) return;
      const link = this.editing();
      this.form.reset({
        targetUrl: link?.targetUrl ?? '',
        title: link?.title ?? '',
        slug: '',
      });
      this.clientErrors.set({});
      this.serverError.set(null);
      this.saving.set(false);
    });
  }

  protected error(field: Field): string | null {
    return (
      this.clientErrors()[field] ?? this.serverError()?.fields[field] ?? null
    );
  }

  protected async submit(): Promise<void> {
    if (this.saving()) return;
    this.serverError.set(null);
    const raw = this.form.getRawValue();
    const link = this.editing();

    const parsed = link
      ? updateLinkSchema.safeParse({
          targetUrl: raw.targetUrl,
          title: raw.title,
        })
      : createLinkSchema.safeParse({
          targetUrl: raw.targetUrl,
          ...(raw.title.trim() && { title: raw.title }),
          ...(raw.slug.trim() && { slug: raw.slug }),
        });
    if (!parsed.success) {
      const errors: Partial<Record<Field, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as Field | undefined;
        if (field && !errors[field])
          errors[field] = sentence(issue.message, field);
      }
      this.clientErrors.set(errors);
      this.focusFirstError();
      return;
    }
    this.clientErrors.set({});

    this.saving.set(true);
    const result = link
      ? await this.api.update(
          link.code,
          parsed.data as Parameters<LinksApi['update']>[1],
        )
      : await this.api.create(
          this.workspaceId(),
          parsed.data as Parameters<LinksApi['create']>[1],
        );
    this.saving.set(false);
    if (result.ok) {
      this.saved.emit(result.value);
      return;
    }
    this.serverError.set(result.error);
    if (result.error.code === 'plan_limit_reached') this.planLimitHit.emit();
    this.focusFirstError();
  }

  /** The dialog renders in an overlay: find its first invalid field by id. */
  private focusFirstError(): void {
    afterNextRender(
      () => {
        const ids: Record<Field, string> = {
          targetUrl: 'link-target',
          slug: 'link-slug',
          title: 'link-title',
        };
        const field = this.visibleFields().find((f) => this.error(f));
        if (field) document.getElementById(ids[field])?.focus();
      },
      { injector: this.injector },
    );
  }
}

/** Turns a schema message ("must be an http(s) URL") into a sentence. */
function sentence(message: string, field: Field): string {
  const subject = {
    targetUrl: 'The URL',
    title: 'The title',
    slug: 'The short code',
  }[field];
  if (/^(must|is) /.test(message)) return `${subject} ${message}.`;
  return message.endsWith('.') ? message : `${message}.`;
}
