/** Plan ids. Limits and prices are added with plan enforcement (#5). */
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
