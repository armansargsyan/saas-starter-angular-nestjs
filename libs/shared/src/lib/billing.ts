import { z } from 'zod';
import { workspaceIdSchema } from './links';

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

/** Query of `GET /api/billing/invoices`. */
export const invoicesQuerySchema = z.strictObject({
  workspaceId: workspaceIdSchema,
});

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
