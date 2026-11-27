import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Placeholder: the teams page arrives in #13. */
@Component({
  selector: 'app-teams-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-2xl font-semibold tracking-tight">Teams</h1>
    <p class="text-muted-foreground mt-2">
      Creating teams and inviting people is coming soon.
    </p>
  `,
})
export class TeamsPage {}
