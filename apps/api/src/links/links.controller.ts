import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  createLinkSchema,
  type Link,
  type LinkListResponse,
  type LinkStatsResponse,
  linkStatsQuerySchema,
  listLinksQuerySchema,
  updateLinkSchema,
  workspaceIdSchema,
} from '@saas-starter/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { LinksService } from './links.service';
import { onlyLimit } from '../common/only-limit.decorator';
import { UserThrottlerGuard } from '../common/user-throttler.guard';

@Controller()
export class LinksController {
  constructor(private readonly links: LinksService) {}

  @Post('workspaces/:workspaceId/links')
  @UseGuards(UserThrottlerGuard)
  @onlyLimit('createLink')
  create(
    @CurrentUser() user: AuthUser,
    @Param('workspaceId', new ZodValidationPipe(workspaceIdSchema))
    workspaceId: string,
    @Body(new ZodValidationPipe(createLinkSchema))
    body: z.output<typeof createLinkSchema>,
  ): Promise<Link> {
    return this.links.create(user, workspaceId, body);
  }

  @Get('workspaces/:workspaceId/links')
  list(
    @CurrentUser() user: AuthUser,
    @Param('workspaceId', new ZodValidationPipe(workspaceIdSchema))
    workspaceId: string,
    @Query(new ZodValidationPipe(listLinksQuerySchema))
    query: z.output<typeof listLinksQuerySchema>,
  ): Promise<LinkListResponse> {
    return this.links.list(user, workspaceId, query);
  }

  @Get('links/:code')
  get(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
  ): Promise<Link> {
    return this.links.get(user, code);
  }

  @Patch('links/:code')
  update(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Body(new ZodValidationPipe(updateLinkSchema))
    body: z.output<typeof updateLinkSchema>,
  ): Promise<Link> {
    return this.links.update(user, code, body);
  }

  @Delete('links/:code')
  @HttpCode(204)
  delete(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
  ): Promise<void> {
    return this.links.delete(user, code);
  }

  @Get('links/:code/stats')
  stats(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Query(new ZodValidationPipe(linkStatsQuerySchema))
    query: z.output<typeof linkStatsQuerySchema>,
  ): Promise<LinkStatsResponse> {
    return this.links.stats(user, code, query);
  }
}
