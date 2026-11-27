import { describe, expect, it } from 'vitest';
import { HealthService } from './health.service';

describe('HealthService', () => {
  it('reports ok with an ISO timestamp', () => {
    const health = new HealthService().getHealth();
    expect(health.status).toBe('ok');
    expect(new Date(health.timestamp).toISOString()).toBe(health.timestamp);
  });
});
