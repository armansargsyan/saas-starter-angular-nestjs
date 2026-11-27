import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  type AdminStatsResponse,
  adminStatsQuerySchema,
  type AdminUser,
  type AdminUserListResponse,
  adminUsersQuerySchema,
  type ImpersonationResponse,
} from '@saas-starter/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser, Roles } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminService } from './admin.service';

const uidParam = new ZodValidationPipe(
  z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'is not a valid uid'),
);

/** Admin panel api: every route needs the `admin` custom claim. */
@Roles('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('users')
  users(
    @Query(new ZodValidationPipe(adminUsersQuerySchema))
    query: z.output<typeof adminUsersQuerySchema>,
  ): Promise<AdminUserListResponse> {
    return this.admin.listUsers(query);
  }

  @Get('users/:uid')
  user(@Param('uid', uidParam) uid: string): Promise<AdminUser> {
    return this.admin.getUser(uid);
  }

  @Post('users/:uid/ban')
  @HttpCode(200)
  ban(
    @CurrentUser() admin: AuthUser,
    @Param('uid', uidParam) uid: string,
  ): Promise<AdminUser> {
    return this.admin.ban(admin, uid);
  }

  @Post('users/:uid/unban')
  @HttpCode(200)
  unban(
    @CurrentUser() admin: AuthUser,
    @Param('uid', uidParam) uid: string,
  ): Promise<AdminUser> {
    return this.admin.unban(admin, uid);
  }

  @Post('users/:uid/impersonate')
  @HttpCode(200)
  impersonate(
    @CurrentUser() admin: AuthUser,
    @Param('uid', uidParam) uid: string,
  ): Promise<ImpersonationResponse> {
    return this.admin.impersonate(admin, uid);
  }

  @Get('stats')
  stats(
    @Query(new ZodValidationPipe(adminStatsQuerySchema))
    query: z.output<typeof adminStatsQuerySchema>,
  ): Promise<AdminStatsResponse> {
    return this.admin.stats(query.days);
  }
}
