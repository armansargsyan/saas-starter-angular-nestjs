import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import type { InvitePreview, Team } from '@saas-starter/shared';
import { FakeAuth } from '../../../testing/fake-auth';
import { settle } from '../../../testing/settle';
import { AuthService } from '../../core/auth.service';
import { WorkspaceService } from '../../core/workspace.service';
import { InvitePage } from './invite-page';

const KEY = 'saas-starter.invite-token';
const TOKEN = 't1.inv1.' + 'a'.repeat(43);

const preview: InvitePreview = {
  teamName: 'Acme',
  role: 'member',
  email: 'u1@example.com',
  expiresAt: '2099-01-01T00:00:00.000Z',
};
const team: Team = {
  id: 't1',
  name: 'Acme',
  role: 'member',
  plan: 'team',
  memberCount: 2,
  createdAt: '2026-11-01T00:00:00.000Z',
};

describe('InvitePage', () => {
  let auth: FakeAuth;
  let http: HttpTestingController;
  let navigate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    auth = new FakeAuth();
    TestBed.configureTestingModule({
      imports: [InvitePage],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: auth },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    navigate = vi
      .spyOn(TestBed.inject(Router), 'navigate')
      .mockResolvedValue(true) as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    http.verify();
    history.replaceState(null, '', '/');
  });

  /** Opens the page; `hash` is the fragment of the invite link. */
  async function open(hash = '') {
    history.replaceState(null, '', `/invite${hash}`);
    const fixture = TestBed.createComponent(InvitePage);
    // Not whenStable: a signed-in visit has requests open until answered.
    TestBed.tick();
    await settle();
    TestBed.tick();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el, q: (s: string) => el.querySelector<HTMLElement>(s) };
  }

  /** Answers the requests a signed-in visit makes (teams list + preview). */
  async function answerPreview(
    fixture: { whenStable(): Promise<unknown> },
    body: object = preview,
    status = 200,
  ) {
    TestBed.tick();
    http.match('/api/teams').forEach((r) => r.flush({ items: [] }));
    const req = http.expectOne('/api/invites/preview');
    expect(req.request.body).toEqual({ token: TOKEN });
    req.flush(body, { status, statusText: status === 200 ? 'OK' : 'Error' });
    await settle();
    await fixture.whenStable();
  }

  it('keeps the token from the link out of the URL and in session storage', async () => {
    const { q } = await open(`#token=${encodeURIComponent(TOKEN)}`);
    expect(TestBed.inject(Location).path(true)).toBe('/invite');
    expect(window.sessionStorage.getItem(KEY)).toBe(TOKEN);
    expect(q('[data-testid="signed-out"]')).not.toBeNull();
    const links = [
      ...(q('[data-testid="signed-out"]')?.querySelectorAll('a') ?? []),
    ];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/login?redirect=%2Finvite',
      '/signup?redirect=%2Finvite',
    ]);
  });

  it('treats a mangled link as incomplete', async () => {
    const { q } = await open('#token=%zz');
    expect(q('[data-testid="no-token"]')).not.toBeNull();
  });

  it('offers a retry after a network failure or rate limit', async () => {
    window.sessionStorage.setItem(KEY, TOKEN);
    auth.signIn('u1');
    const { fixture, q, el } = await open();
    await answerPreview(fixture, {}, 429);
    expect(q('[data-testid="failed"]')?.textContent).toContain(
      'Too many requests',
    );
    [...el.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Try again'))
      ?.click();
    await settle();
    TestBed.tick();
    http.expectOne('/api/invites/preview').flush(preview);
    await settle();
    await fixture.whenStable();
    expect(q('[data-testid="accept"]')).not.toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBe(TOKEN); // kept for the retry
  });

  it('says when there is no token', async () => {
    const { q } = await open();
    expect(q('[data-testid="no-token"]')).not.toBeNull();
  });

  it('previews and accepts, then opens the team in its workspace', async () => {
    window.sessionStorage.setItem(KEY, TOKEN);
    auth.signIn('u1');
    const { fixture, q, el } = await open();
    await answerPreview(fixture);
    expect(el.textContent).toContain('Join Acme');
    expect(el.textContent).toContain('invited as member');

    q('[data-testid="accept"]')?.click();
    await settle();
    const req = http.expectOne('/api/invites/accept');
    expect(req.request.body).toEqual({ token: TOKEN });
    req.flush(team);
    await settle();
    TestBed.tick();
    http.match('/api/teams').forEach((r) => r.flush({ items: [team] }));
    await fixture.whenStable();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(TestBed.inject(WorkspaceService).workspaceId()).toBe('t1');
    expect(navigate).toHaveBeenCalledWith(['/teams', 't1']);
  });

  it('declines', async () => {
    window.sessionStorage.setItem(KEY, TOKEN);
    auth.signIn('u1');
    const { fixture, q } = await open();
    await answerPreview(fixture);
    q('[data-testid="decline"]')?.click();
    await settle();
    http.expectOne('/api/invites/decline').flush(null);
    await settle();
    await fixture.whenStable();
    expect(q('[data-testid="declined"]')).not.toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it('explains a different signed-in account, and keeps the invite for the right one', async () => {
    window.sessionStorage.setItem(KEY, TOKEN);
    auth.signIn('u2');
    const { fixture, q, el } = await open();
    await answerPreview(fixture);
    expect(q('[data-testid="wrong-account"]')?.textContent).toContain(
      'This invite is for u1@example.com',
    );
    expect(q('[data-testid="accept"]')).toBeNull();
    [...el.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('another account'))
      ?.click();
    await settle();
    expect(auth.signOut).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { redirect: '/invite' },
    });
    expect(window.sessionStorage.getItem(KEY)).toBe(TOKEN);
  });

  it('asks to verify the email first', async () => {
    window.sessionStorage.setItem(KEY, TOKEN);
    auth.signIn('u1', { emailVerified: false, providers: ['password'] });
    const { fixture, q } = await open();
    await answerPreview(fixture);
    expect(q('[data-testid="unverified"]')).not.toBeNull();
    expect(q('[data-testid="accept"]')).toBeNull();
  });

  it('forgets an invalid or expired invite', async () => {
    window.sessionStorage.setItem(KEY, TOKEN);
    auth.signIn('u1');
    const { fixture, q } = await open();
    await answerPreview(
      fixture,
      {
        code: 'invite_expired',
        message: 'This invite has expired; ask for a new one',
      },
      410,
    );
    expect(q('[data-testid="failed"]')?.textContent).toContain('expired');
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it('shows a seat-limit refusal on accept without dropping the invite', async () => {
    window.sessionStorage.setItem(KEY, TOKEN);
    auth.signIn('u1');
    const { fixture, q } = await open();
    await answerPreview(fixture);
    q('[data-testid="accept"]')?.click();
    await settle();
    http.expectOne('/api/invites/accept').flush(
      {
        statusCode: 403,
        code: 'plan_limit_reached',
        message: 'Your Team plan allows 5 members.',
        resource: 'members',
        limit: 5,
        plan: 'team',
      },
      { status: 403, statusText: 'Forbidden' },
    );
    await settle();
    await fixture.whenStable();
    expect(q('[data-testid="error"]')?.textContent).toContain(
      'allows 5 members',
    );
    expect(window.sessionStorage.getItem(KEY)).toBe(TOKEN);
  });
});
