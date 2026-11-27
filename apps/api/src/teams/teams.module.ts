import { Module } from '@nestjs/common';
import { Clock } from '../common/clock';
import { RateLimitModule } from '../common/rate-limit.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { InviteMailer, NoopInviteMailer } from './invite.mailer';
import { InvitesController } from './invites.controller';
import { TeamsController } from './teams.controller';
import { FirestoreTeamsRepository, TeamsRepository } from './teams.repository';
import { TeamsService } from './teams.service';

@Module({
  imports: [WorkspacesModule, RateLimitModule],
  controllers: [TeamsController, InvitesController],
  providers: [
    TeamsService,
    Clock,
    { provide: TeamsRepository, useClass: FirestoreTeamsRepository },
    { provide: InviteMailer, useClass: NoopInviteMailer },
  ],
})
export class TeamsModule {}
