import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideRouter, type Route, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { FakeAuth } from '../../../testing/fake-auth';
import { settle } from '../../../testing/settle';
import { AuthService } from '../../core/auth.service';
import { SIGNED_IN_ROUTES } from '../../layout/signed-in.routes';

@Component({ template: 'dashboard' })
class Dashboard {}

/** The real /admin route (guard + lazy page), without the shell. */
const adminRoute = SIGNED_IN_ROUTES[0].children?.find(
  (r) => r.path === 'admin',
) as Route;

describe('/admin', () => {
  let auth: FakeAuth;

  beforeEach(() => {
    auth = new FakeAuth();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          adminRoute,
          { path: 'dashboard', component: Dashboard },
          { path: 'login', component: Dashboard },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: auth },
      ],
    });
  });

  it('sends non-admins to the dashboard', async () => {
    auth.signIn('u1');
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/admin');
    expect(TestBed.inject(Router).url).toBe('/dashboard');
  });

  it('sends impersonated sessions to the dashboard too', async () => {
    auth.signIn('u1');
    auth.role.set('admin');
    auth.impersonatedBy.set('admin-1');
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/admin');
    expect(TestBed.inject(Router).url).toBe('/dashboard');
  });

  it('shows the stats and the users to admins', async () => {
    auth.signIn('admin1');
    auth.role.set('admin');
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/admin');
    expect(TestBed.inject(Router).url).toBe('/admin');
    const http = TestBed.inject(HttpTestingController);
    TestBed.tick();
    http.expectOne('/api/admin/stats?days=30');
    http.expectOne((req) => req.url === '/api/admin/users');
    await settle();
    const el = harness.routeNativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent).toContain('Admin');
    expect(el.querySelector('app-admin-stats')).not.toBeNull();
    expect(el.querySelector('app-admin-users')).not.toBeNull();
    http.verify();
  });
});
