import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  type ProfileResponse,
  updateProfileSchema,
} from '@saas-starter/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/decorators';
import { onlyLimit } from '../common/only-limit.decorator';
import { UserThrottlerGuard } from '../common/user-throttler.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AccountService } from './account.service';

/** The caller's own account (always the caller's: no uid in the path). */
@Controller('account')
@UseGuards(UserThrottlerGuard)
@onlyLimit('account')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Patch('profile')
  updateProfile(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(updateProfileSchema))
    body: z.output<typeof updateProfileSchema>,
  ): Promise<ProfileResponse> {
    return this.account.updateProfile(user, body);
  }

  /** Cancels subscriptions, deletes the user's data, then the user. Safe to retry. */
  @Delete()
  @HttpCode(204)
  delete(@CurrentUser() user: AuthUser): Promise<void> {
    return this.account.deleteAccount(user);
  }
}
