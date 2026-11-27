import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  type CreateInviteResponse,
  createInviteSchema,
  createTeamSchema,
  type Team,
  type TeamInviteListResponse,
  type TeamListResponse,
  type TeamMemberListResponse,
  updateMemberSchema,
  updateTeamSchema,
  workspaceIdSchema,
} from '@saas-starter/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/decorators';
import { onlyLimit } from '../common/only-limit.decorator';
import { UserThrottlerGuard } from '../common/user-throttler.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TeamsService } from './teams.service';

const teamId = new ZodValidationPipe(workspaceIdSchema);
const docId = new ZodValidationPipe(
  z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'is not a valid id'),
);

@Controller('teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Post()
  @UseGuards(UserThrottlerGuard)
  @onlyLimit('teamWrites')
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createTeamSchema))
    body: z.output<typeof createTeamSchema>,
  ): Promise<Team> {
    return this.teams.create(user, body.name);
  }

  @Get()
  list(@CurrentUser() user: AuthUser): Promise<TeamListResponse> {
    return this.teams.list(user);
  }

  @Get(':teamId')
  get(
    @CurrentUser() user: AuthUser,
    @Param('teamId', teamId) id: string,
  ): Promise<Team> {
    return this.teams.get(user, id);
  }

  @Patch(':teamId')
  rename(
    @CurrentUser() user: AuthUser,
    @Param('teamId', teamId) id: string,
    @Body(new ZodValidationPipe(updateTeamSchema))
    body: z.output<typeof updateTeamSchema>,
  ): Promise<Team> {
    return this.teams.rename(user, id, body.name);
  }

  @Get(':teamId/members')
  members(
    @CurrentUser() user: AuthUser,
    @Param('teamId', teamId) id: string,
  ): Promise<TeamMemberListResponse> {
    return this.teams.listMembers(user, id);
  }

  @Patch(':teamId/members/:uid')
  @HttpCode(204)
  setRole(
    @CurrentUser() user: AuthUser,
    @Param('teamId', teamId) id: string,
    @Param('uid', docId) uid: string,
    @Body(new ZodValidationPipe(updateMemberSchema))
    body: z.output<typeof updateMemberSchema>,
  ): Promise<void> {
    return this.teams.setRole(user, id, uid, body.role);
  }

  /** Remove a member, or leave the team (your own uid). */
  @Delete(':teamId/members/:uid')
  @HttpCode(204)
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('teamId', teamId) id: string,
    @Param('uid', docId) uid: string,
  ): Promise<void> {
    return this.teams.removeMember(user, id, uid);
  }

  @Post(':teamId/invites')
  @UseGuards(UserThrottlerGuard)
  @onlyLimit('teamWrites')
  invite(
    @CurrentUser() user: AuthUser,
    @Param('teamId', teamId) id: string,
    @Body(new ZodValidationPipe(createInviteSchema))
    body: z.output<typeof createInviteSchema>,
  ): Promise<CreateInviteResponse> {
    return this.teams.invite(user, id, body);
  }

  @Get(':teamId/invites')
  invites(
    @CurrentUser() user: AuthUser,
    @Param('teamId', teamId) id: string,
  ): Promise<TeamInviteListResponse> {
    return this.teams.listInvites(user, id);
  }

  @Delete(':teamId/invites/:inviteId')
  @HttpCode(204)
  revoke(
    @CurrentUser() user: AuthUser,
    @Param('teamId', teamId) id: string,
    @Param('inviteId', docId) inviteId: string,
  ): Promise<void> {
    return this.teams.revokeInvite(user, id, inviteId);
  }
}
