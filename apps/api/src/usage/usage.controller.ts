import { Controller, Get, Query } from '@nestjs/common';
import { type UsageResponse, usageQuerySchema } from '@saas-starter/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { UsageService } from './usage.service';

@Controller('usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  get(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(usageQuerySchema))
    query: z.output<typeof usageQuerySchema>,
  ): Promise<UsageResponse> {
    return this.usage.get(user, query.workspaceId);
  }
}
