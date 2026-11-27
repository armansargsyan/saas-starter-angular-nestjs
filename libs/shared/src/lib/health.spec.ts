import { describe, expect, it } from 'vitest';
import type { HealthResponse } from './health';

describe('HealthResponse', () => {
  it('describes an ok status with an ISO timestamp', () => {
    const health: HealthResponse = {
      status: 'ok',
      timestamp: new Date(0).toISOString(),
    };
    expect(health).toEqual({
      status: 'ok',
      timestamp: '1970-01-01T00:00:00.000Z',
    });
  });
});
