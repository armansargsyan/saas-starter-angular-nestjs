import { DOCUMENT, inject, Injectable } from '@angular/core';

const KEY = 'saas-starter.invite-token';

/**
 * Holds an invite token while the invitee signs in, signs up or verifies
 * their email. Session storage: it stays in this tab and is gone when the
 * tab closes (the token is a secret).
 */
@Injectable({ providedIn: 'root' })
export class PendingInvite {
  private readonly storage = inject(DOCUMENT).defaultView?.sessionStorage;

  get(): string | null {
    try {
      return this.storage?.getItem(KEY) ?? null;
    } catch {
      return null; // storage blocked
    }
  }

  set(token: string): void {
    try {
      this.storage?.setItem(KEY, token);
    } catch {
      // storage blocked: the invite still works in this page view
    }
  }

  clear(): void {
    try {
      this.storage?.removeItem(KEY);
    } catch {
      // nothing to clear
    }
  }
}
