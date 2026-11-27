import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Placeholder: the admin panel arrives in #14. */
@Component({
  selector: 'app-admin-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main id="main" class="mx-auto max-w-3xl px-4 py-10">
      <h1 class="text-2xl font-semibold tracking-tight">Admin</h1>
    </main>
  `,
})
export class AdminPage {}
