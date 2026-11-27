import { Module } from '@nestjs/common';
import { Clock } from '../common/clock';
import { RateLimitModule } from '../common/rate-limit.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ClickLimiter } from './click-limiter';
import { GeoipLiteLocator, GeoLocator } from './geo.locator';
import { LinksController } from './links.controller';
import { FirestoreLinksRepository, LinksRepository } from './links.repository';
import { LinksService } from './links.service';
import { RedirectController } from './redirect.controller';
import { ReferrerBudget } from './referrer-budget';

@Module({
  imports: [WorkspacesModule, RateLimitModule],
  controllers: [LinksController, RedirectController],
  providers: [
    LinksService,
    Clock,
    ClickLimiter,
    ReferrerBudget,
    { provide: LinksRepository, useClass: FirestoreLinksRepository },
    { provide: GeoLocator, useClass: GeoipLiteLocator },
  ],
})
export class LinksModule {}
