import { ChangeDetectionStrategy, Component, computed } from '@angular/core';
import { httpResource } from '@angular/common/http';
import type { HealthResponse } from '@saas-starter/shared';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmButtonImports } from '@spartan-ng/helm/button';

type ApiStatus = 'checking' | 'ok' | 'down';

@Component({
  selector: 'app-home',
  imports: [HlmBadgeImports, HlmButtonImports],
  templateUrl: './home-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomePage {
  protected readonly health = httpResource<HealthResponse>(() => '/api/health');

  protected readonly status = computed<ApiStatus>(() => {
    if (this.health.isLoading()) return 'checking';
    if (this.health.error()) return 'down';
    return this.health.value()?.status === 'ok' ? 'ok' : 'down';
  });
}
