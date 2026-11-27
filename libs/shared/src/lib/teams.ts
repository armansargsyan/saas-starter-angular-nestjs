import { z } from 'zod';
import type { PlanId } from './plans';

export const TEAM_ROLES = ['owner', 'admin', 'member'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/** Roles that can be given by invite or role change (there is one owner). */
export const ASSIGNABLE_ROLES = ['admin', 'member'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/**
 * Who may do what in a team:
 * - owner: everything, including billing and changing roles
 * - admin: manage members and invites (invite members, remove members)
 * - member: use the team's links, see the member list
 */
export const TEAM_PERMISSIONS = {
  manageBilling: ['owner'],
  changeRoles: ['owner'],
  inviteAdmins: ['owner'],
  inviteMembers: ['owner', 'admin'],
  removeMembers: ['owner', 'admin'],
  revokeInvites: ['owner', 'admin'],
  renameTeam: ['owner', 'admin'],
} as const satisfies Record<string, readonly TeamRole[]>;
export type TeamPermission = keyof typeof TEAM_PERMISSIONS;

export function can(
  role: TeamRole | null,
  permission: TeamPermission,
): boolean {
  return (
    role !== null &&
    (TEAM_PERMISSIONS[permission] as readonly TeamRole[]).includes(role)
  );
}

/** Invites expire after this many days. */
export const INVITE_TTL_DAYS = 7;

const teamName = z
  .string()
  .trim()
  .min(1, 'is required')
  .max(60, 'must be at most 60 characters');

/** Body of `POST /api/teams`. */
export const createTeamSchema = z.strictObject({ name: teamName });
/** Body of `PATCH /api/teams/:teamId`. */
export const updateTeamSchema = z.strictObject({ name: teamName });

/** Body of `POST /api/teams/:teamId/invites`. */
export const createInviteSchema = z.strictObject({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email({ error: 'must be an email address' })),
  role: z.enum(ASSIGNABLE_ROLES).default('member'),
});

/** Body of `PATCH /api/teams/:teamId/members/:uid`. */
export const updateMemberSchema = z.strictObject({
  role: z.enum(ASSIGNABLE_ROLES),
});

/** Body of `POST /api/invites/preview|accept|decline`. Never put the token in a URL query. */
export const inviteTokenSchema = z.strictObject({
  token: z
    .string()
    .regex(
      /^[A-Za-z0-9_-]{1,128}\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{43}$/,
      'is not a valid invite',
    ),
});

export interface Team {
  id: string;
  name: string;
  /** The caller's role in this team. */
  role: TeamRole;
  plan: PlanId;
  memberCount: number;
  createdAt: string;
}

export interface TeamListResponse {
  items: Team[];
}

export interface TeamMember {
  uid: string;
  email: string | null;
  role: TeamRole;
  joinedAt: string;
}

export interface TeamMemberListResponse {
  items: TeamMember[];
}

export type InviteStatus = 'pending' | 'accepted' | 'declined' | 'revoked';

export interface TeamInvite {
  id: string;
  email: string;
  role: AssignableRole;
  status: InviteStatus;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
}

export interface TeamInviteListResponse {
  items: TeamInvite[];
}

/** Response of `POST /api/teams/:teamId/invites`. The token is only ever shown here. */
export interface CreateInviteResponse {
  invite: TeamInvite;
  /** Link for the invitee: `<APP_URL>/invite#token=…` (fragment: never sent to servers). */
  acceptUrl: string;
}

/** Response of `POST /api/invites/preview { token }`: what the invitee is joining. */
export interface InvitePreview {
  teamName: string;
  role: AssignableRole;
  email: string;
  expiresAt: string;
}
