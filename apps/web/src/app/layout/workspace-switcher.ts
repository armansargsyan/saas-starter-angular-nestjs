import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { HlmNativeSelectImports } from '@spartan-ng/helm/native-select';
import { AuthService } from '../core/auth.service';
import { WorkspaceService } from '../core/workspace.service';

/** Personal workspace or one of your teams; shown once you're in a team. */
@Component({
  selector: 'app-workspace-switcher',
  imports: [HlmNativeSelectImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (workspaces.teams().length) {
      <label [for]="selectId()" class="sr-only">Workspace</label>
      <hlm-native-select
        [selectId]="selectId()"
        size="sm"
        selectClass="max-w-40 truncate"
        [value]="workspaces.workspaceId() ?? ''"
        (valueChange)="workspaces.select($event || null)"
        data-testid="workspace-switcher"
      >
        <option hlmNativeSelectOption [value]="uid()">Personal</option>
        @for (team of workspaces.teams(); track team.id) {
          <option hlmNativeSelectOption [value]="team.id">
            {{ team.name }}
          </option>
        }
      </hlm-native-select>
    }
  `,
})
export class WorkspaceSwitcher {
  /** Unique per instance (the shell has one for wide and one for narrow screens). */
  readonly selectId = input('workspace-switcher');

  protected readonly workspaces = inject(WorkspaceService);
  private readonly auth = inject(AuthService);
  protected readonly uid = computed(() => this.auth.user()?.uid ?? '');
}
