import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import type { Team } from '@saas-starter/shared';
import { FakeAuth } from '../../../testing/fake-auth';
import { settle } from '../../../testing/settle';
import { AuthService } from '../../core/auth.service';
import { WorkspaceService } from '../../core/workspace.service';
import { TeamsPage } from './teams-page';

const team = (id: string, overrides: Partial<Team> = {}): Team => ({
  id,
  name: `Team ${id}`,
  role: 'owner',
  plan: 'team',
  memberCount: 3,
  createdAt: '2026-11-01T00:00:00.000Z',
  ...overrides,
});

describe('TeamsPage', () => {
  let auth: FakeAuth;
  let http: HttpTestingController;
  let navigate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    auth = new FakeAuth();
    auth.signIn('u1');
    TestBed.configureTestingModule({
      imports: [TeamsPage],
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

  afterEach(() => http.verify());

  async function render(items: Team[] = [], isNew?: string) {
    const fixture = TestBed.createComponent(TeamsPage);
    if (isNew) fixture.componentRef.setInput('new', isNew);
    TestBed.tick();
    http.expectOne('/api/teams').flush({ items });
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el, q: (s: string) => el.querySelector<HTMLElement>(s) };
  }

  it('lists your teams with your role, members and plan', async () => {
    const { el } = await render([
      team('t1'),
      team('t2', { role: 'member', memberCount: 1, plan: 'free' }),
    ]);
    const cards = el.querySelectorAll('[data-testid="team-list"] a');
    expect(cards).toHaveLength(2);
    expect(cards[0].getAttribute('href')).toBe('/teams/t1');
    expect(cards[0].textContent).toContain('3 members · Team plan');
    expect(cards[0].textContent).toContain('Owner');
    expect(cards[1].textContent).toContain('1 member · Free plan');
  });

  it('has an empty state', async () => {
    const { q } = await render();
    expect(q('[data-testid="empty"]')).not.toBeNull();
  });

  it('creates a team, switches to it and opens it', async () => {
    const { fixture, q } = await render();
    const input = q('[data-testid="team-name"]') as HTMLInputElement;
    input.value = '  Acme  ';
    input.dispatchEvent(new Event('input'));
    q('[data-testid="create-team"]')?.click();
    await settle();
    const req = http.expectOne('/api/teams');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ name: 'Acme' });
    req.flush(team('t9', { name: 'Acme' }));
    await settle();
    TestBed.tick();
    http
      .expectOne('/api/teams')
      .flush({ items: [team('t9', { name: 'Acme' })] });
    await fixture.whenStable();
    expect(TestBed.inject(WorkspaceService).workspaceId()).toBe('t9');
    expect(navigate).toHaveBeenCalledWith(['/teams', 't9']);
  });

  it('asks for a name, and shows server errors on the field', async () => {
    const { fixture, q } = await render();
    q('[data-testid="create-team"]')?.click();
    await fixture.whenStable();
    expect(q('#team-name-error')?.textContent).toContain('Enter a name');
    expect(document.activeElement?.id).not.toBe(''); // focus moved to the field

    const input = q('[data-testid="team-name"]') as HTMLInputElement;
    input.value = 'x'.repeat(5);
    input.dispatchEvent(new Event('input'));
    q('[data-testid="create-team"]')?.click();
    await settle();
    http.expectOne('/api/teams').flush(
      {
        issues: [{ path: 'name', message: 'must be at most 60 characters' }],
      },
      { status: 400, statusText: 'Bad Request' },
    );
    await settle();
    await fixture.whenStable();
    expect(q('#team-name-error')?.textContent).toContain(
      'Must be at most 60 characters',
    );
    expect(q('[data-testid="team-name"]')?.getAttribute('aria-invalid')).toBe(
      'true',
    );
  });

  it('focuses the form after signing up for the Team plan', async () => {
    const fixture = TestBed.createComponent(TeamsPage);
    document.body.appendChild(fixture.nativeElement);
    fixture.componentRef.setInput('new', '1');
    TestBed.tick();
    http.expectOne('/api/teams').flush({ items: [] });
    await fixture.whenStable();
    expect(document.activeElement?.id).toBe('team-name');
    fixture.nativeElement.remove();
  });

  it('shows a retry when the list fails', async () => {
    const fixture = TestBed.createComponent(TeamsPage);
    TestBed.tick();
    http
      .expectOne('/api/teams')
      .flush('boom', { status: 500, statusText: 'x' });
    await fixture.whenStable();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="load-error"]',
      ),
    ).not.toBeNull();
  });

  it('hides creating in an impersonated (read-only) session', async () => {
    auth.impersonatedBy.set('admin-1');
    const { q } = await render();
    expect(q('[data-testid="create-team"]')).toBeNull();
  });
});
