import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  type InvitePreview,
  inviteTokenSchema,
  type Team,
} from '@saas-starter/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/decorators';
import { onlyLimit } from '../common/only-limit.decorator';
import { UserThrottlerGuard } from '../common/user-throttler.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TeamsService } from './teams.service';

const tokenBody = new ZodValidationPipe(inviteTokenSchema);

/**
 * The invitee's side. Signed in (global guard) and rate limited against
 * guessing. The token always travels in a POST body, never in a URL.
 */
@Controller('invites')
@UseGuards(UserThrottlerGuard)
@onlyLimit('invites')
export class InvitesController {
  constructor(private readonly teams: TeamsService) {}

  @Post('preview')
  @HttpCode(200)
  preview(
    @Body(tokenBody) body: z.output<typeof inviteTokenSchema>,
  ): Promise<InvitePreview> {
    return this.teams.preview(body.token);
  }

  @Post('accept')
  @HttpCode(200)
  accept(
    @CurrentUser() user: AuthUser,
    @Body(tokenBody) body: z.output<typeof inviteTokenSchema>,
  ): Promise<Team> {
    return this.teams.accept(user, body.token);
  }

  @Post('decline')
  @HttpCode(204)
  decline(
    @CurrentUser() user: AuthUser,
    @Body(tokenBody) body: z.output<typeof inviteTokenSchema>,
  ): Promise<void> {
    return this.teams.decline(user, body.token);
  }
}
