import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { OVERLAY_DEFAULT_CONFIG } from '@angular/cdk/overlay';
import { provideRouter, Router } from '@angular/router';
import {
  PLANS,
  type Team,
  type TeamInvite,
  type TeamMember,
  type TeamRole,
} from '@saas-starter/shared';
import { FakeAuth } from '../../../testing/fake-auth';
import { settle } from '../../../testing/settle';
import { AuthService } from '../../core/auth.service';
import { WorkspaceService } from '../../core/workspace.service';
import { TeamPage } from './team-page';

const TEAM = '/api/teams/t1';
const MEMBERS = '/api/teams/t1/members';
const INVITES = '/api/teams/t1/invites';

const team = (role: TeamRole, overrides: Partial<Team> = {}): Team => ({
  id: 't1',
  name: 'Acme',
  role,
  plan: 'team',
  memberCount: 3,
  createdAt: '2026-11-01T00:00:00.000Z',
  ...overrides,
});
const member = (uid: string, role: TeamRole): TeamMember => ({
  uid,
  email: `${uid}@example.com`,
  role,
  joinedAt: '2026-11-02T00:00:00.000Z',
});
const MEMBERS_LIST = [
  member('owner1', 'owner'),
  member('admin1', 'admin'),
  member('mem1', 'member'),
];
const invite = (
  email: string,
  overrides: Partial<TeamInvite> = {},
): TeamInvite => ({
  id: `inv-${email}`,
  email,
  role: 'member',
  status: 'pending',
  invitedBy: 'owner1',
  createdAt: '2026-11-20T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
  ...overrides,
});

describe('TeamPage', () => {
  let auth: FakeAuth;
  let http: HttpTestingController;

  beforeEach(() => {
    window.localStorage.clear();
    auth = new FakeAuth();
    TestBed.configureTestingModule({
      imports: [TeamPage],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: auth },
        { provide: OVERLAY_DEFAULT_CONFIG, useValue: { usePopover: false } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    document.body
      .querySelectorAll('.cdk-overlay-container')
      .forEach((n) => n.remove());
  });

  /** Renders as `me` with `role` in team t1. */
  async function render(
    me: string,
    role: TeamRole,
    opts: { team?: Partial<Team>; invites?: TeamInvite[] } = {},
  ) {
    auth.signIn(me);
    const fixture = TestBed.createComponent(TeamPage);
    document.body.appendChild(fixture.nativeElement);
    fixture.componentRef.setInput('teamId', 't1');
    TestBed.tick();
    http.expectOne('/api/teams').flush({ items: [team(role, opts.team)] });
    http.expectOne(TEAM).flush(team(role, opts.team));
    http.expectOne(MEMBERS).flush({ items: MEMBERS_LIST });
    await settle();
    TestBed.tick();
    if (role !== 'member' && !auth.impersonatedBy()) {
      http.expectOne(INVITES).flush({ items: opts.invites ?? [] });
    }
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const q = (s: string) => el.querySelector<HTMLElement>(s);
    const row = (uid: string) =>
      el.querySelector<HTMLElement>(`[data-member="${uid}"]`);
    return { fixture, el, q, row };
  }

  const type = (el: HTMLElement | null, value: string) => {
    (el as HTMLInputElement).value = value;
    el?.dispatchEvent(new Event('input'));
  };

  describe('as the owner', () => {
    it('shows members with roles, seats, and owner-only controls', async () => {
      const { q, row, fixture } = await render('owner1', 'owner');
      expect(q('[data-testid="team-name"]')?.textContent).toContain('Acme');
      expect(q('[data-testid="my-role"]')?.textContent).toContain(
        'You’re owner',
      );
      expect(q('[data-testid="seats"]')?.textContent).toContain(
        `3 of ${PLANS.team.limits.members} seats used`,
      );
      expect(row('owner1')?.textContent).toContain('(you)');
      expect(
        row('owner1')?.querySelector('[data-testid="role"]')?.textContent,
      ).toContain('Owner');
      expect(row('owner1')?.querySelector('[data-testid="leave"]')).toBeNull(); // owner can't leave
      expect(
        row('admin1')?.querySelector('[data-testid="role-select"]'),
      ).not.toBeNull();
      expect(
        row('admin1')?.querySelector('[data-testid="remove"]'),
      ).not.toBeNull();
      const roles = [...(q('#invite-role') as HTMLSelectElement).options].map(
        (o) => o.value,
      );
      expect(roles).toEqual(['member', 'admin']);
      fixture.nativeElement.remove();
    });

    it('changes a role', async () => {
      const { fixture, row } = await render('owner1', 'owner');
      const select = row('mem1')?.querySelector('select') as HTMLSelectElement;
      select.value = 'admin';
      select.dispatchEvent(new Event('change'));
      await settle();
      const req = http.expectOne(`${MEMBERS}/mem1`);
      expect(req.request.method).toBe('PATCH');
      expect(req.request.body).toEqual({ role: 'admin' });
      req.flush(null);
      await settle();
      TestBed.tick();
      http.expectOne(MEMBERS).flush({ items: MEMBERS_LIST });
      await fixture.whenStable();
      fixture.nativeElement.remove();
    });

    it('puts the role back when the change fails', async () => {
      const { fixture, row, q } = await render('owner1', 'owner');
      const select = row('mem1')?.querySelector('select') as HTMLSelectElement;
      select.value = 'admin';
      select.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      // While it saves, no other role can change.
      expect(row('admin1')?.querySelector('select')?.disabled).toBe(true);
      await settle();
      http
        .expectOne(`${MEMBERS}/mem1`)
        .flush(
          { message: 'Your role in this team does not allow that' },
          { status: 403, statusText: 'x' },
        );
      await settle();
      TestBed.tick();
      http.expectOne(MEMBERS).flush({ items: MEMBERS_LIST });
      await fixture.whenStable();
      expect(select.value).toBe('member');
      expect(q('[data-testid="notice"]')?.textContent).toContain(
        'does not allow that',
      );
      fixture.nativeElement.remove();
    });

    it('removes a member after confirmation', async () => {
      const { fixture, row, q } = await render('owner1', 'owner');
      row('mem1')
        ?.querySelector<HTMLElement>('[data-testid="remove"]')
        ?.click();
      await fixture.whenStable();
      expect(
        document.querySelector('h2[hlmAlertDialogTitle]')?.textContent,
      ).toContain('Remove mem1@example.com?');
      document
        .querySelector<HTMLElement>('[data-testid="confirm-remove"]')
        ?.click();
      await settle();
      const req = http.expectOne(`${MEMBERS}/mem1`);
      expect(req.request.method).toBe('DELETE');
      req.flush(null);
      await settle();
      TestBed.tick();
      http.expectOne('/api/teams').flush({ items: [team('owner')] });
      http.expectOne(MEMBERS).flush({ items: MEMBERS_LIST.slice(0, 2) });
      http.expectOne(TEAM).flush(team('owner', { memberCount: 2 }));
      await fixture.whenStable();
      expect(q('[data-testid="announcement"]')?.textContent).toContain(
        'Removed mem1',
      );
      fixture.nativeElement.remove();
    });

    it('creates an invite and shows the link to share', async () => {
      const { fixture, q } = await render('owner1', 'owner');
      type(q('[data-testid="invite-email"]'), 'new@example.com');
      const role = q('#invite-role') as HTMLSelectElement;
      role.value = 'admin';
      role.dispatchEvent(new Event('change'));
      q('[data-testid="send-invite"]')?.click();
      await settle();
      const req = http.expectOne(INVITES);
      expect(req.request.body).toEqual({
        email: 'new@example.com',
        role: 'admin',
      });
      req.flush({
        invite: invite('new@example.com', { role: 'admin' }),
        acceptUrl: 'https://app.test/invite#token=abc',
      });
      await settle();
      TestBed.tick();
      http
        .expectOne(INVITES)
        .flush({ items: [invite('new@example.com', { role: 'admin' })] });
      await fixture.whenStable();
      expect(q('[data-testid="invite-link-box"]')?.textContent).toContain(
        'Share this link with new@example.com',
      );
      expect((q('[data-testid="invite-link"]') as HTMLInputElement).value).toBe(
        'https://app.test/invite#token=abc',
      );
      expect(document.activeElement?.id).toBe('invite-link');
      expect(
        (q('[data-testid="invite-email"]') as HTMLInputElement).value,
      ).toBe('');

      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
      q('[data-testid="copy-link"]')?.click();
      await settle();
      expect(writeText).toHaveBeenCalledWith(
        'https://app.test/invite#token=abc',
      );
      fixture.nativeElement.remove();
    });

    it('asks for an email and shows the api error on the field', async () => {
      const { fixture, q } = await render('owner1', 'owner');
      q('[data-testid="send-invite"]')?.click();
      await fixture.whenStable();
      expect(q('#invite-error')?.textContent).toContain(
        'Enter an email address',
      );

      type(q('[data-testid="invite-email"]'), 'nope');
      q('[data-testid="send-invite"]')?.click();
      await settle();
      http
        .expectOne(INVITES)
        .flush(
          { issues: [{ path: 'email', message: 'must be an email address' }] },
          { status: 400, statusText: 'Bad Request' },
        );
      await settle();
      await fixture.whenStable();
      expect(q('#invite-error')?.textContent).toContain(
        'Must be an email address',
      );
      expect(document.activeElement?.id).toBe('invite-email');
      fixture.nativeElement.remove();
    });

    it('lists pending invites, makes a new link and revokes', async () => {
      const { fixture, el, q } = await render('owner1', 'owner', {
        invites: [
          invite('a@example.com'),
          invite('old@example.com', { expiresAt: '2020-01-01T00:00:00.000Z' }),
          invite('done@example.com', { status: 'accepted' }),
        ],
      });
      const rows = el.querySelectorAll('[data-testid="invite-list"] li');
      expect(rows).toHaveLength(2); // accepted ones aren't pending
      expect(rows[1].textContent).toContain('Expired');

      rows[0].querySelector<HTMLElement>('[data-testid="resend"]')?.click();
      await settle();
      const again = http.expectOne(INVITES);
      expect(again.request.body).toEqual({
        email: 'a@example.com',
        role: 'member',
      });
      again.flush({
        invite: invite('a@example.com'),
        acceptUrl: 'https://app.test/invite#token=new',
      });
      await settle();
      TestBed.tick();
      http.expectOne(INVITES).flush({ items: [invite('a@example.com')] });
      await fixture.whenStable();
      expect(
        (q('[data-testid="invite-link"]') as HTMLInputElement).value,
      ).toContain('token=new');

      el.querySelector<HTMLElement>('[data-testid="revoke"]')?.click();
      await settle();
      const revoke = http.expectOne(`${INVITES}/inv-a%40example.com`);
      expect(revoke.request.method).toBe('DELETE');
      revoke.flush(null);
      await settle();
      TestBed.tick();
      http.expectOne(INVITES).flush({ items: [] });
      await fixture.whenStable();
      expect(q('[data-testid="invite-link-box"]')).toBeNull(); // that link is dead now
      expect(q('[data-testid="no-invites"]')).not.toBeNull();
      fixture.nativeElement.remove();
    });

    it('on the Free plan, offers the upgrade instead of inviting', async () => {
      const navigateByUrl = vi
        .spyOn(TestBed.inject(Router), 'navigateByUrl')
        .mockResolvedValue(true);
      const { fixture, q } = await render('owner1', 'owner', {
        team: { plan: 'free', memberCount: 1 },
      });
      expect(q('[data-testid="seats"]')?.textContent).toContain(
        '1 of 1 seat used',
      );
      expect(q('[data-testid="seats-full"]')?.textContent).toContain(
        'Upgrade to Team',
      );
      expect(q('[data-testid="send-invite"]')).toBeNull();
      q('[data-testid="upgrade"]')?.click();
      expect(TestBed.inject(WorkspaceService).workspaceId()).toBe('t1');
      expect(navigateByUrl).toHaveBeenCalledWith('/billing');
      fixture.nativeElement.remove();
    });

    it('renames the team', async () => {
      const { fixture, q } = await render('owner1', 'owner');
      q('[data-testid="rename"]')?.click();
      await fixture.whenStable();
      type(q('[data-testid="rename-input"]'), 'Acme Inc');
      q('[data-testid="rename-save"]')?.click();
      await settle();
      const req = http.expectOne(TEAM);
      expect(req.request.method).toBe('PATCH');
      req.flush(team('owner', { name: 'Acme Inc' }));
      await settle();
      TestBed.tick();
      http
        .expectOne('/api/teams')
        .flush({ items: [team('owner', { name: 'Acme Inc' })] });
      await fixture.whenStable();
      expect(q('[data-testid="team-name"]')?.textContent).toContain('Acme Inc');
      fixture.nativeElement.remove();
    });

    it('switches to the team', async () => {
      const navigateByUrl = vi
        .spyOn(TestBed.inject(Router), 'navigateByUrl')
        .mockResolvedValue(true);
      const { fixture, q } = await render('owner1', 'owner');
      q('[data-testid="use-team"]')?.click();
      await fixture.whenStable();
      expect(navigateByUrl).toHaveBeenCalledWith('/dashboard');
      expect(q('[data-testid="current"]')).not.toBeNull();
      fixture.nativeElement.remove();
    });
  });

  describe('as an admin', () => {
    it('removes members but not admins, changes no roles, invites only members', async () => {
      const { fixture, q, row } = await render('admin1', 'admin');
      expect(
        row('mem1')?.querySelector('[data-testid="remove"]'),
      ).not.toBeNull();
      expect(row('owner1')?.querySelector('[data-testid="remove"]')).toBeNull();
      expect(
        row('admin1')?.querySelector('[data-testid="leave"]'),
      ).not.toBeNull();
      expect(q('[data-testid="role-select"]')).toBeNull();
      const roles = [...(q('#invite-role') as HTMLSelectElement).options].map(
        (o) => o.value,
      );
      expect(roles).toEqual(['member']);
      fixture.nativeElement.remove();
    });
  });

  describe('as a member', () => {
    it('sees the members (no invites) and can leave', async () => {
      const navigateByUrl = vi
        .spyOn(TestBed.inject(Router), 'navigateByUrl')
        .mockResolvedValue(true);
      const { fixture, q, row } = await render('mem1', 'member');
      expect(q('#invite-title')).toBeNull();
      expect(q('[data-testid="rename"]')).toBeNull();
      expect(row('admin1')?.querySelector('[data-testid="remove"]')).toBeNull();

      TestBed.inject(WorkspaceService).select('t1');
      row('mem1')?.querySelector<HTMLElement>('[data-testid="leave"]')?.click();
      await fixture.whenStable();
      expect(
        document.querySelector('h2[hlmAlertDialogTitle]')?.textContent,
      ).toContain('Leave Acme?');
      document
        .querySelector<HTMLElement>('[data-testid="confirm-remove"]')
        ?.click();
      await settle();
      http.expectOne(`${MEMBERS}/mem1`).flush(null);
      await settle();
      TestBed.tick();
      http.expectOne('/api/teams').flush({ items: [] });
      await fixture.whenStable();
      expect(TestBed.inject(WorkspaceService).workspaceId()).toBe('mem1');
      expect(navigateByUrl).toHaveBeenCalledWith('/teams');
      fixture.nativeElement.remove();
    });
  });

  it('says when the team is not found (or not yours)', async () => {
    auth.signIn('u1');
    const fixture = TestBed.createComponent(TeamPage);
    fixture.componentRef.setInput('teamId', 't1');
    TestBed.tick();
    http.expectOne('/api/teams').flush({ items: [] });
    http.expectOne(TEAM).flush({}, { status: 404, statusText: 'Not Found' });
    http.expectOne(MEMBERS).flush({}, { status: 404, statusText: 'Not Found' });
    await fixture.whenStable();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="not-found"]',
      ),
    ).not.toBeNull();
  });

  it('shows failures visibly', async () => {
    const { fixture, q, el } = await render('owner1', 'owner', {
      invites: [invite('a@example.com')],
    });
    el.querySelector<HTMLElement>('[data-testid="revoke"]')?.click();
    await settle();
    http
      .expectOne(`${INVITES}/inv-a%40example.com`)
      .flush(
        { message: 'No pending invite with that id' },
        { status: 404, statusText: 'x' },
      );
    await settle();
    TestBed.tick();
    http.expectOne(INVITES).flush({ items: [] });
    await fixture.whenStable();
    expect(q('[data-testid="notice"]')?.textContent).toContain(
      'No pending invite',
    );
    fixture.nativeElement.remove();
  });

  it('is read-only while impersonating', async () => {
    auth.impersonatedBy.set('admin-x');
    const { fixture, q } = await render('owner1', 'owner');
    expect(q('[data-testid="rename"]')).toBeNull();
    expect(q('[data-testid="role-select"]')).toBeNull();
    expect(q('[data-testid="remove"]')).toBeNull();
    expect(q('#invite-title')).toBeNull();
    fixture.nativeElement.remove();
  });
});
