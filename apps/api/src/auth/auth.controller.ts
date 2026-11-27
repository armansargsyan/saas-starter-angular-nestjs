import { Controller, Get } from '@nestjs/common';
import type { MeResponse } from '@saas-starter/shared';
import type { AuthUser } from './auth-user';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<MeResponse> {
    return this.authService.me(user);
  }
}
