import { Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { BillingController } from './billing.controller';
import { BillingProvider } from './billing.provider';
import {
  BillingRepository,
  FirestoreBillingRepository,
} from './billing.repository';
import { BillingService } from './billing.service';
import { createStripeClient, STRIPE_CLIENT } from './stripe.client';
import { StripeBillingProvider } from './stripe-billing.provider';

@Module({
  imports: [WorkspacesModule],
  controllers: [BillingController],
  providers: [
    BillingService,
    {
      provide: STRIPE_CLIENT,
      inject: [AppConfigService],
      useFactory: createStripeClient,
    },
    { provide: BillingProvider, useClass: StripeBillingProvider },
    { provide: BillingRepository, useClass: FirestoreBillingRepository },
  ],
})
export class BillingModule {}
