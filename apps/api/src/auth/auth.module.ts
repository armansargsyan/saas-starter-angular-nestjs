import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { FirebaseAuthGuard } from './firebase-auth.guard';
import { RolesGuard } from './roles.guard';
import { FirestoreUsersRepository, UsersRepository } from './users.repository';

@Module({
  imports: [WorkspacesModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    { provide: UsersRepository, useClass: FirestoreUsersRepository },
    // Order matters: authenticate first, then check roles.
    { provide: APP_GUARD, useClass: FirebaseAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AuthModule {}
