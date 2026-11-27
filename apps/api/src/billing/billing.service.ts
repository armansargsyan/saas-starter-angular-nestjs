import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  type ApiErrorBody,
  can,
  effectivePlanId,
  type InvoiceListResponse,
  type PaidPlanId,
  type RedirectUrlResponse,
} from '@saas-starter/shared';
import type { AuthUser } from '../auth/auth-user';
import { AppConfigService } from '../config/app-config.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import {
  BillingProvider,
  InvalidWebhookSignatureError,
  LIVE_STATUSES,
  type ProviderSubscription,
} from './billing.provider';
import { BillingRepository, type WorkspaceBilling } from './billing.repository';

const INVOICE_LIMIT = 24;

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly provider: BillingProvider,
    private readonly repo: BillingRepository,
    private readonly access: WorkspaceAccessService,
    private readonly config: AppConfigService,
  ) {}

  /** Starts Stripe Checkout for Pro (personal) or Team (team workspace). */
  async createCheckout(
    user: AuthUser,
    workspaceId: string,
    plan: PaidPlanId,
  ): Promise<RedirectUrlResponse> {
    const billing = await this.assertOwner(user, workspaceId);
    const personal = workspaceId === user.uid;
    if ((plan === 'pro') !== personal) {
      throw new BadRequestException(
        errorBody(
          400,
          'plan_not_available',
          'Pro is for personal workspaces, Team for teams',
        ),
      );
    }
    // Plan state comes from the webhook-synced record, never the client.
    if (effectivePlanId(billing.plan) !== 'free') throw alreadySubscribed();

    return this.callProvider(async () => {
      // The synced plan lags behind Stripe until the webhook lands (e.g. a
      // second tab right after paying): ask Stripe too, so one workspace
      // never pays for two subscriptions.
      if (billing.stripeCustomerId) {
        const live = await this.provider.listLiveSubscriptions(
          billing.stripeCustomerId,
        );
        if (live.length > 0) throw alreadySubscribed();
        // Only the newest Checkout can be paid: two tabs can't both charge.
        await this.provider.expireOpenCheckoutSessions(
          billing.stripeCustomerId,
        );
      }
      const customerId =
        billing.stripeCustomerId ??
        (await this.repo.saveCustomerId(
          workspaceId,
          await this.provider.createCustomer({
            workspaceId,
            email: user.email,
          }),
          personal ? user.uid : null,
        ));
      const url = await this.provider.createCheckoutSession({
        customerId,
        priceId: this.config.stripe.prices[plan],
        workspaceId,
        successUrl: `${this.config.appUrl}/billing?checkout=success`,
        cancelUrl: `${this.config.appUrl}/billing?checkout=canceled`,
      });
      return { url };
    });
  }

  /** Stripe's customer portal: plan changes, cancellation, payment method, invoices. */
  async createPortal(
    user: AuthUser,
    workspaceId: string,
  ): Promise<RedirectUrlResponse> {
    const billing = await this.assertOwner(user, workspaceId);
    const customerId = billing.stripeCustomerId;
    if (!customerId) {
      throw new ConflictException(
        errorBody(
          409,
          'no_billing_account',
          'Nothing to manage yet: subscribe first',
        ),
      );
    }
    return this.callProvider(async () => ({
      url: await this.provider.createPortalSession({
        customerId,
        returnUrl: `${this.config.appUrl}/billing`,
      }),
    }));
  }

  async listInvoices(
    user: AuthUser,
    workspaceId: string,
  ): Promise<InvoiceListResponse> {
    const billing = await this.assertOwner(user, workspaceId);
    const customerId = billing.stripeCustomerId;
    if (!customerId) return { items: [] };
    return this.callProvider(async () => ({
      items: await this.provider.listInvoices(customerId, INVOICE_LIMIT),
    }));
  }

  /**
   * Verifies and applies a Stripe webhook. The subscription is re-fetched from
   * Stripe instead of trusting the payload or event order, so handling is
   * idempotent and replay-safe; `stripeEvents/{id}` skips duplicates. Errors
   * propagate (500) so Stripe retries; the event is marked only once applied.
   */
  async handleWebhook(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<void> {
    if (!rawBody || !signature) {
      throw new BadRequestException('Missing body or Stripe-Signature');
    }
    let event;
    try {
      event = this.provider.parseWebhook(rawBody, signature);
    } catch (err) {
      if (err instanceof InvalidWebhookSignatureError) {
        throw new BadRequestException('Invalid signature');
      }
      throw err;
    }

    if (event.livemode) {
      // Test mode only: a live endpoint's secret must never change plans here.
      this.logger.warn(`Ignored live-mode event ${event.id}`);
      return;
    }
    if (!event.subscriptionId) return; // Not handled: acknowledge and ignore.
    if (await this.repo.isEventProcessed(event.id)) return;

    const outcome = await this.syncSubscription(event.subscriptionId);
    const message = `${event.type} ${event.id}: ${outcome}`;
    // Anything but "applied" deserves attention (e.g. a misconfigured price id).
    if (outcome === 'applied') this.logger.log(message);
    else this.logger.warn(message);
    await this.repo.markEventProcessed(event.id, event.type);
  }

  private async syncSubscription(subscriptionId: string): Promise<string> {
    const sub = await this.provider.getSubscription(subscriptionId);
    if (!sub) return 'subscription_not_found';

    const workspaceId =
      sub.workspaceId ??
      (await this.repo.findWorkspaceIdByCustomer(sub.customerId));
    if (!workspaceId) return 'unknown_workspace';

    if (LIVE_STATUSES.has(sub.status)) return this.applyLive(workspaceId, sub);

    // Ended. If the customer still has another live subscription that fits
    // this workspace (two checkouts paid before the first webhook), it takes
    // over; otherwise the end is recorded whatever the price, so a paid plan
    // can never outlive its subscription.
    for (const other of await this.provider.listLiveSubscriptions(
      sub.customerId,
    )) {
      if (other.id === sub.id) continue;
      if ((await this.applyLive(workspaceId, other)) === 'applied') {
        return `replaced_by_${other.id}`;
      }
    }
    return this.repo.endSubscription(workspaceId, sub);
  }

  /** Price → plan, then the repository's workspace checks. */
  private async applyLive(
    workspaceId: string,
    sub: ProviderSubscription,
  ): Promise<string> {
    const planId = this.planForPrice(sub.priceId);
    if (!planId) return 'unknown_price';
    return this.repo.applySubscription(workspaceId, sub, planId);
  }

  private planForPrice(priceId: string | null): PaidPlanId | null {
    const { prices } = this.config.stripe;
    if (priceId === prices.pro) return 'pro';
    if (priceId === prices.team) return 'team';
    return null;
  }

  /** Billing is managed by the workspace owner only (the team role decides). */
  private async assertOwner(
    user: AuthUser,
    workspaceId: string,
  ): Promise<WorkspaceBilling> {
    const role = await this.access.getRole(user, workspaceId);
    if (!role) throw new NotFoundException('Workspace not found');
    if (!can(role, 'manageBilling')) {
      throw new ForbiddenException(
        'Only the workspace owner can manage billing',
      );
    }
    return this.repo.getWorkspaceBilling(workspaceId);
  }

  /** Provider failures become a 503 without leaking Stripe's error details. */
  private async callProvider<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`Billing provider error: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        'Billing is temporarily unavailable',
      );
    }
  }
}

function alreadySubscribed() {
  return new ConflictException(
    errorBody(
      409,
      'already_subscribed',
      'Already subscribed; manage the plan in the billing portal',
    ),
  );
}

function errorBody<C extends ApiErrorBody['code']>(
  statusCode: number,
  code: C,
  message: string,
): ApiErrorBody<C> {
  return { statusCode, code, message };
}
