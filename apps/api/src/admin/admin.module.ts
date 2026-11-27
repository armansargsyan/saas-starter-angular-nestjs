import { Module } from '@nestjs/common';
import { Clock } from '../common/clock';
import { AdminController } from './admin.controller';
import { AdminRepository, FirestoreAdminRepository } from './admin.repository';
import { AdminService } from './admin.service';
import {
  AuditLogRepository,
  FirestoreAuditLogRepository,
} from './audit-log.repository';

@Module({
  controllers: [AdminController],
  providers: [
    AdminService,
    Clock,
    { provide: AdminRepository, useClass: FirestoreAdminRepository },
    { provide: AuditLogRepository, useClass: FirestoreAuditLogRepository },
  ],
})
export class AdminModule {}
