import { Injectable } from '@nestjs/common';
import type { HealthResponse } from '@saas-starter/shared';

@Injectable()
export class HealthService {
  getHealth(): HealthResponse {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
