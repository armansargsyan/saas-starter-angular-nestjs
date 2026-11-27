import { TestBed } from '@angular/core/testing';
import {
  HttpClient,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { FakeAuth } from '../../testing/fake-auth';
import { settle } from '../../testing/settle';
import { authInterceptor } from './auth.interceptor';
import { AuthService } from './auth.service';

describe('authInterceptor', () => {
  let auth: FakeAuth;
  let http: HttpTestingController;
  let client: HttpClient;

  beforeEach(() => {
    auth = new FakeAuth();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: auth },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    client = TestBed.inject(HttpClient);
  });

  afterEach(() => http.verify());

  it('adds the bearer token to /api calls when signed in', async () => {
    auth.signIn();
    const done = firstValueFrom(client.get('/api/usage'));
    await settle();
    const req = http.expectOne('/api/usage');
    expect(req.request.headers.get('Authorization')).toBe('Bearer test-token');
    req.flush({});
    await done;
  });

  it('sends no token when signed out', async () => {
    const done = firstValueFrom(client.get('/api/health'));
    await settle();
    const req = http.expectOne('/api/health');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({});
    await done;
  });

  it('never sends the token to other origins', async () => {
    auth.signIn();
    const done = firstValueFrom(client.get('https://example.com/api/x'));
    const req = http.expectOne('https://example.com/api/x');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({});
    await done;
  });

  it('never sends the token to protocol-relative URLs', async () => {
    auth.signIn();
    const done = firstValueFrom(client.get('//evil.test/api/x'));
    const req = http.expectOne('//evil.test/api/x');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({});
    await done;
  });
});
