/** Plan ids. */
export const PLAN_IDS = ['free', 'pro', 'team'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** Stripe subscription statuses, mirrored into `workspace.plan.status`. */
export const PLAN_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'canceled',
  'unpaid',
  'incomplete',
  'incomplete_expired',
  'paused',
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** `workspaces/{id}.plan`, written only by Stripe webhooks. */
export interface WorkspacePlan {
  id: PlanId;
  status: PlanStatus;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

/** Statuses that keep a paid plan; anything else falls back to Free. */
const PAID_STATUSES: ReadonlySet<PlanStatus> = new Set([
  'active',
  'trialing',
  'past_due',
]);

/** The plan a workspace actually gets, given what Stripe last reported. */
export function effectivePlanId(
  plan: WorkspacePlan | null | undefined,
): PlanId {
  if (!plan || !PAID_STATUSES.has(plan.status)) return 'free';
  return plan.id;
}

/** Seats in a Team workspace (owner included). */
export const TEAM_MAX_SEATS = 10;

/** `null` means unlimited. */
export interface PlanLimits {
  links: number | null;
  members: number | null;
}

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** Display price in USD per month; Stripe price ids live in api config. */
  priceMonthlyUsd: number;
  limits: PlanLimits;
  features: string[];
}

/**
 * The single source of truth for plans: the api enforces these limits and
 * the pricing table renders them. Billing maps Stripe prices onto the ids.
 */
export const PLANS: Readonly<Record<PlanId, PlanDefinition>> = {
  free: {
    id: 'free',
    name: 'Free',
    priceMonthlyUsd: 0,
    limits: { links: 10, members: 1 },
    features: ['10 short links', 'Click analytics (90 days)', 'Custom slugs'],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthlyUsd: 9,
    limits: { links: null, members: 1 },
    features: [
      'Unlimited short links',
      'Click analytics (90 days)',
      'Custom slugs',
    ],
  },
  team: {
    id: 'team',
    name: 'Team',
    priceMonthlyUsd: 29,
    limits: { links: null, members: TEAM_MAX_SEATS },
    features: [
      'Unlimited short links',
      `Up to ${TEAM_MAX_SEATS} team members`,
      'Shared links and analytics',
      'Roles: owner, admin, member',
    ],
  },
};

/** Whether one more item fits under `limit` (null = unlimited). */
export function hasRoomFor(used: number, limit: number | null): boolean {
  return limit === null || used < limit;
}

export interface UsageMeter {
  used: number;
  /** null = unlimited */
  limit: number | null;
}

/** Response of `GET /api/usage?workspaceId=…` (query: `usageQuerySchema`). The UI only displays it. */
export interface UsageResponse {
  workspaceId: string;
  plan: PlanId;
  links: UsageMeter;
  members: UsageMeter;
}
