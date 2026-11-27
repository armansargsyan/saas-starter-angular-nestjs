import { Module } from '@nestjs/common';
import {
  FirestoreWorkspacesRepository,
  WorkspacesRepository,
} from './workspaces.repository';

@Module({
  providers: [
    { provide: WorkspacesRepository, useClass: FirestoreWorkspacesRepository },
  ],
  exports: [WorkspacesRepository],
})
export class WorkspacesModule {}
