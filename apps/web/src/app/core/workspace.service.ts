import { computed, inject, Injectable } from '@angular/core';
import { AuthService } from './auth.service';

/**
 * The workspace the signed-in pages work in. For now always the personal
 * workspace (id = uid); the team switcher arrives with the Teams page (#13).
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceService {
  private readonly auth = inject(AuthService);

  readonly workspaceId = computed(() => this.auth.user()?.uid ?? null);
  readonly isPersonal = computed(
    () => !!this.workspaceId() && this.workspaceId() === this.auth.user()?.uid,
  );
}
