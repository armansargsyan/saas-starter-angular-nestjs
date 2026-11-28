import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { Clock } from '../common/clock';
import { RateLimitModule } from '../common/rate-limit.module';
import { AccountController } from './account.controller';
import {
  AccountRepository,
  FirestoreAccountRepository,
} from './account.repository';
import { AccountService } from './account.service';

@Module({
  imports: [BillingModule, RateLimitModule],
  controllers: [AccountController],
  providers: [
    AccountService,
    Clock,
    { provide: AccountRepository, useClass: FirestoreAccountRepository },
  ],
})
export class AccountModule {}
