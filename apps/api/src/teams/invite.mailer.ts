import { Injectable, Logger } from '@nestjs/common';

export interface InviteEmail {
  to: string;
  teamName: string;
  invitedBy: string | null;
  acceptUrl: string;
}

/**
 * Delivers invite emails. No email provider is configured yet, so the
 * inviter gets the accept link in the API response and shares it; a real
 * provider (e.g. Resend, SendGrid) plugs in here behind this interface.
 */
export abstract class InviteMailer {
  abstract send(email: InviteEmail): Promise<void>;
}

@Injectable()
export class NoopInviteMailer extends InviteMailer {
  private readonly logger = new Logger(NoopInviteMailer.name);

  async send(email: InviteEmail): Promise<void> {
    // Never log the link: it contains the invite secret.
    this.logger.log(
      `Invite email not sent (no provider configured) for team "${email.teamName}"`,
    );
  }
}
