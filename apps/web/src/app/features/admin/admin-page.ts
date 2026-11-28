import { ChangeDetectionStrategy, Component } from '@angular/core';
import { AdminStats } from './admin-stats';
import { AdminUsers } from './admin-users';

/**
 * The admin panel (behind adminGuard, a UI hint: every admin api route
 * checks the `admin` claim server-side).
 */
@Component({
  selector: 'app-admin-page',
  imports: [AdminStats, AdminUsers],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="grid gap-10">
      <header>
        <h1 class="text-2xl font-semibold tracking-tight">Admin</h1>
        <p class="text-muted-foreground mt-1 text-sm">
          Revenue, growth and user management. Every admin action is
          audit-logged.
        </p>
      </header>
      <app-admin-stats />
      <app-admin-users />
    </div>
  `,
})
export class AdminPage {}
