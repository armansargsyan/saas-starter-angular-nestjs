import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@saas-starter/shared';
import { Public } from '../auth/decorators';
import { HealthService } from './health.service';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  getHealth(): HealthResponse {
    return this.healthService.getHealth();
  }
}
