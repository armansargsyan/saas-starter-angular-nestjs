import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { Clock } from '../common/clock';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ClickLimiter } from './click-limiter';
import { GeoipLiteLocator, GeoLocator } from './geo.locator';
import { LinksController } from './links.controller';
import { FirestoreLinksRepository, LinksRepository } from './links.repository';
import { LinksService } from './links.service';
import { RedirectController } from './redirect.controller';
import { ReferrerBudget } from './referrer-budget';
import { UserThrottlerGuard } from './user-throttler.guard';

/** Link creation: 30 per minute per user (in memory, per instance). */
export const CREATE_LINK_LIMIT = { ttl: 60_000, limit: 30 };

@Module({
  imports: [WorkspacesModule, ThrottlerModule.forRoot([CREATE_LINK_LIMIT])],
  controllers: [LinksController, RedirectController],
  providers: [
    LinksService,
    Clock,
    ClickLimiter,
    ReferrerBudget,
    UserThrottlerGuard,
    { provide: LinksRepository, useClass: FirestoreLinksRepository },
    { provide: GeoLocator, useClass: GeoipLiteLocator },
  ],
})
export class LinksModule {}
