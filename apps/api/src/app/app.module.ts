import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { AppConfigModule } from '../config/app-config.module';
import { FirebaseModule } from '../firebase/firebase.module';
import { HealthModule } from '../health/health.module';
import { LinksModule } from '../links/links.module';
import { TeamsModule } from '../teams/teams.module';
import { UsageModule } from '../usage/usage.module';

@Module({
  imports: [
    AppConfigModule,
    FirebaseModule,
    AuthModule,
    HealthModule,
    LinksModule,
    UsageModule,
    BillingModule,
    TeamsModule,
  ],
})
export class AppModule {}
