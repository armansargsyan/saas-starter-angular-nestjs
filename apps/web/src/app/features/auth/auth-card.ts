import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmCardImports } from '@spartan-ng/helm/card';

/** Centered card layout shared by the sign-in pages. */
@Component({
  selector: 'app-auth-card',
  imports: [RouterLink, HlmCardImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main
      id="main"
      class="bg-muted/40 flex min-h-dvh flex-col items-center justify-center px-4 py-10"
    >
      <a
        routerLink="/"
        class="mb-8 flex items-center gap-2 font-semibold tracking-tight"
      >
        <span
          aria-hidden="true"
          class="bg-primary text-primary-foreground grid size-7 place-items-center rounded-md text-xs font-bold"
          >S</span
        >
        SaaS Starter
      </a>
      <section hlmCard class="w-full max-w-sm" aria-labelledby="auth-title">
        <div hlmCardHeader>
          <h1 hlmCardTitle id="auth-title" class="text-xl">{{ heading() }}</h1>
          @if (description()) {
            <p hlmCardDescription>{{ description() }}</p>
          }
        </div>
        <div hlmCardContent>
          <ng-content />
        </div>
      </section>
      <div class="text-muted-foreground mt-6 text-center text-sm">
        <ng-content select="[authFooter]" />
      </div>
    </main>
  `,
})
export class AuthCard {
  readonly heading = input.required<string>();
  readonly description = input<string>();
}
