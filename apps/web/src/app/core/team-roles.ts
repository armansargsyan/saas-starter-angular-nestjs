import type { TeamRole } from '@saas-starter/shared';

/** How team roles read in the UI. */
export const ROLE_LABELS: Record<TeamRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};
