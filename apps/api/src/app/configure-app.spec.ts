import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  Header,
  type INestApplication,
  Module,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { configureApp } from './configure-app';

@Controller('things')
class ThingsController {
  @Get()
  list() {
    return { ok: true };
  }

  @Get('cached')
  @Header('Cache-Control', 'private, max-age=60')
  cached() {
    return { ok: true };
  }
}

// Mounted outside the /api prefix, like the public redirect.
@Controller('r')
class OutsideController {
  @Get(':code')
  redirect() {
    return 'outside';
  }
}

@Module({ controllers: [ThingsController, OutsideController] })
class TestModule {}

describe('configureApp', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, { trustProxyHops: 1 });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('marks api responses no-store', async () => {
    const res = await fetch(`${baseUrl}/api/things`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('marks api errors no-store too', async () => {
    const res = await fetch(`${baseUrl}/api/missing`);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('lets a handler set its own Cache-Control', async () => {
    const res = await fetch(`${baseUrl}/api/things/cached`);
    expect(res.headers.get('cache-control')).toBe('private, max-age=60');
  });

  it('leaves routes outside the prefix alone', async () => {
    const res = await fetch(`${baseUrl}/r/abc`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBeNull();
  });
});
