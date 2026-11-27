import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import {
  checkoutRequestSchema,
  type InvoiceListResponse,
  invoicesQuerySchema,
  portalRequestSchema,
  type RedirectUrlResponse,
} from '@saas-starter/shared';
import type { Request } from 'express';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser, Public } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { BillingService } from './billing.service';

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Post('checkout')
  @HttpCode(200)
  checkout(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(checkoutRequestSchema))
    body: z.output<typeof checkoutRequestSchema>,
  ): Promise<RedirectUrlResponse> {
    return this.billing.createCheckout(user, body.workspaceId, body.plan);
  }

  @Post('portal')
  @HttpCode(200)
  portal(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(portalRequestSchema))
    body: z.output<typeof portalRequestSchema>,
  ): Promise<RedirectUrlResponse> {
    return this.billing.createPortal(user, body.workspaceId);
  }

  @Get('invoices')
  invoices(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(invoicesQuerySchema))
    query: z.output<typeof invoicesQuerySchema>,
  ): Promise<InvoiceListResponse> {
    return this.billing.listInvoices(user, query.workspaceId);
  }

  /** Stripe → us. Authenticated by the signature over the raw body, not a token. */
  @Public()
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    await this.billing.handleWebhook(req.rawBody, signature);
    return { received: true };
  }
}
