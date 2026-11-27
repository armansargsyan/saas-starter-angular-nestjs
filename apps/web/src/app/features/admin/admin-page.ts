import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Placeholder: the admin panel arrives in #14. */
@Component({
  selector: 'app-admin-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ` <h1 class="text-2xl font-semibold tracking-tight">Admin</h1> `,
})
export class AdminPage {}
