import { Module } from '@nestjs/common';
import { WorkspaceAccessService } from './workspace-access.service';
import {
  FirestoreWorkspacesRepository,
  WorkspacesRepository,
} from './workspaces.repository';

@Module({
  providers: [
    { provide: WorkspacesRepository, useClass: FirestoreWorkspacesRepository },
    WorkspaceAccessService,
  ],
  exports: [WorkspacesRepository, WorkspaceAccessService],
})
export class WorkspacesModule {}
