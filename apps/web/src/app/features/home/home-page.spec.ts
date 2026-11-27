import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import type { HealthResponse } from '@saas-starter/shared';
import { HomePage } from './home-page';

const OK: HealthResponse = {
  status: 'ok',
  timestamp: new Date(0).toISOString(),
};

describe('HomePage', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HomePage],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  function render() {
    const fixture = TestBed.createComponent(HomePage);
    const el = fixture.nativeElement as HTMLElement;
    const status = () =>
      el.querySelector('[data-testid="api-status"]')?.textContent?.trim();
    return { fixture, el, status };
  }

  it('shows the title and "checking" while the health request is pending', async () => {
    const { fixture, el, status } = render();
    // Not whenStable(): it would wait for the pending health request.
    TestBed.tick();

    expect(el.querySelector('h1')?.textContent).toContain('SaaS Starter');
    expect(status()).toBe('checking…');
    http.expectOne('/api/health').flush(OK);
    await fixture.whenStable();
  });

  it('shows ok when the api is healthy', async () => {
    const { fixture, status } = render();
    TestBed.tick();
    http.expectOne('/api/health').flush(OK);
    await fixture.whenStable();

    expect(status()).toBe('ok');
  });

  it('shows unreachable when the request fails, and retries on click', async () => {
    const { fixture, el, status } = render();
    TestBed.tick();
    http
      .expectOne('/api/health')
      .flush('down', { status: 502, statusText: 'Bad Gateway' });
    await fixture.whenStable();
    expect(status()).toBe('unreachable');

    el.querySelector('button')?.click();
    TestBed.tick();
    expect(status()).toBe('checking…');
    http.expectOne('/api/health').flush(OK);
    await fixture.whenStable();
    expect(status()).toBe('ok');
  });
});
