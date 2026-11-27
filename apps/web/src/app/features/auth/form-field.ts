import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { HlmLabelImports } from '@spartan-ng/helm/label';

/** Label + projected control + error text, wired with ids for screen readers. */
@Component({
  selector: 'app-form-field',
  imports: [HlmLabelImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="grid gap-2">
      <label hlmLabel [for]="for()">{{ label() }}</label>
      <ng-content />
      @if (error()) {
        <p [id]="for() + '-error'" class="text-destructive text-sm">
          {{ error() }}
        </p>
      } @else if (hint()) {
        <p [id]="for() + '-hint'" class="text-muted-foreground text-sm">
          {{ hint() }}
        </p>
      }
    </div>
  `,
})
export class FormField {
  readonly for = input.required<string>();
  readonly label = input.required<string>();
  readonly error = input<string | null>(null);
  readonly hint = input<string>();
}
