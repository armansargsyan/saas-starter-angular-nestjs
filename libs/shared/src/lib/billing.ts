import { z } from 'zod';
import { workspaceIdSchema } from './links';
import type { PlanId, WorkspacePlan } from './plans';

/** Plans that can be bought; Free is what you get without a subscription. */
export const PAID_PLAN_IDS = ['pro', 'team'] as const;
export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];

/** Body of `POST /api/billing/checkout`. */
export const checkoutRequestSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  /** Pro is for personal workspaces, Team for team workspaces. */
  plan: z.enum(PAID_PLAN_IDS),
});
export type CheckoutRequest = z.input<typeof checkoutRequestSchema>;

/** Body of `POST /api/billing/portal`. */
export const portalRequestSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
});
export type PortalRequest = z.input<typeof portalRequestSchema>;

/** Query of the workspace-scoped billing reads (`subscription`, `invoices`). */
export const workspaceQuerySchema = z.strictObject({
  workspaceId: workspaceIdSchema,
});

/** Response of `GET /api/billing/subscription` (owner only). */
export interface SubscriptionResponse {
  workspaceId: string;
  /** The plan the workspace gets now (Free unless the subscription is live). */
  plan: PlanId;
  /** What Stripe last reported through the webhook; null before a purchase. */
  subscription: WorkspacePlan | null;
  /** A Stripe customer exists, so the billing portal can be opened. */
  canOpenPortal: boolean;
}

/** Response of checkout and portal: where to send the browser. */
export interface RedirectUrlResponse {
  url: string;
}

export interface Invoice {
  id: string;
  number: string | null;
  status: string | null;
  /** Smallest currency unit (e.g. cents). */
  amountDue: number;
  amountPaid: number;
  currency: string;
  createdAt: string;
  /** Stripe-hosted invoice page. */
  hostedInvoiceUrl: string | null;
  pdfUrl: string | null;
}

export interface InvoiceListResponse {
  items: Invoice[];
}
