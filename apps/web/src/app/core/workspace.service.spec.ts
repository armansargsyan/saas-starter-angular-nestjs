import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import type { Team } from '@saas-starter/shared';
import { FakeAuth } from '../../testing/fake-auth';
import { settle } from '../../testing/settle';
import { AuthService } from './auth.service';
import { WorkspaceService } from './workspace.service';

const team = (id: string): Team => ({
  id,
  name: id.toUpperCase(),
  role: 'member',
  plan: 'team',
  memberCount: 2,
  createdAt: '2026-11-01T00:00:00.000Z',
});

describe('WorkspaceService', () => {
  let auth: FakeAuth;
  let http: HttpTestingController;
  let service: WorkspaceService;

  beforeEach(() => {
    window.localStorage.clear();
    auth = new FakeAuth();
    auth.signIn('u1');
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: auth },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(WorkspaceService);
  });

  afterEach(() => http.verify());

  const loadTeams = (items: Team[]) => {
    TestBed.tick();
    http.expectOne('/api/teams').flush({ items });
  };

  it('starts in the personal workspace', async () => {
    loadTeams([team('t1')]);
    await settle();
    expect(service.workspaceId()).toBe('u1');
    expect(service.isPersonal()).toBe(true);
    expect(service.currentTeam()).toBeNull();
  });

  it('switches to a team and remembers it per user', async () => {
    loadTeams([team('t1')]);
    await settle();
    service.select('t1');
    expect(service.workspaceId()).toBe('t1');
    expect(service.isPersonal()).toBe(false);
    expect(window.localStorage.getItem('saas-starter.workspace:u1')).toBe('t1');

    service.select(null);
    expect(service.workspaceId()).toBe('u1');
  });

  it('restores the choice, and falls back to personal for a team you left', async () => {
    window.localStorage.setItem('saas-starter.workspace:u1', 't9');
    const fresh = TestBed.inject(WorkspaceService);
    TestBed.tick();
    // Until the list confirms it, a stored team isn't used (pages wait).
    expect(fresh.workspaceId()).toBeNull();
    http.expectOne('/api/teams').flush({ items: [team('t1')] });
    await settle();
    expect(fresh.workspaceId()).toBe('u1');
  });

  it('starts over for another user, and has no workspace when signed out', async () => {
    loadTeams([team('t1')]);
    await settle();
    service.select('t1');
    auth.signIn('u2');
    TestBed.tick();
    http.expectOne('/api/teams').flush({ items: [] });
    expect(service.workspaceId()).toBe('u2');

    auth.setSignedOut();
    TestBed.tick();
    expect(service.workspaceId()).toBeNull();
    expect(service.isPersonal()).toBe(false);
  });

  it('keeps a just-joined team while the list reloads', async () => {
    loadTeams([]);
    await settle();
    service.refreshTeams();
    service.select('t2');
    TestBed.tick();
    expect(service.workspaceId()).toBe('t2'); // not personal mid-reload
    http.expectOne('/api/teams').flush({ items: [team('t2')] });
    await settle();
    expect(service.workspaceId()).toBe('t2');
  });

  it('uses a stored team once confirmed, and personal if the list fails', async () => {
    window.localStorage.setItem('saas-starter.workspace:u1', 't1');
    loadTeams([team('t1')]);
    await settle();
    expect(service.workspaceId()).toBe('t1');

    service.refreshTeams();
    TestBed.tick();
    http
      .expectOne('/api/teams')
      .flush('boom', { status: 500, statusText: 'Server Error' });
    await settle();
    expect(service.workspaceId()).toBe('u1');
  });
});
