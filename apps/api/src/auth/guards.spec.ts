import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { IdentityProvider } from '../firebase/identity.provider';
import type { AuthUser } from './auth-user';
import { CurrentUser, Public, Roles } from './decorators';
import { FirebaseAuthGuard } from './firebase-auth.guard';
import { RolesGuard } from './roles.guard';

@Controller('t')
class TestController {
  @Public()
  @Get('public')
  open() {
    return { ok: true };
  }

  @Get('private')
  whoAmI(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Roles('admin')
  @Get('admin')
  adminOnly() {
    return { ok: true };
  }

  @Public()
  @Roles('admin')
  @Get('misconfigured')
  misconfigured() {
    return { ok: true };
  }
}

@Roles('admin')
@Controller('admin-class')
class AdminController {
  @Get()
  list() {
    return { ok: true };
  }
}

const ISSUED = new Date('2026-06-01T12:00:00.000Z');

const identity = {
  verifyIdToken: vi.fn(),
  getUser: vi.fn(),
};

describe('auth guards', () => {
  let app: INestApplication;
  let baseUrl: string;

  const get = (path: string, token?: string) =>
    fetch(`${baseUrl}/api${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TestController, AdminController],
      providers: [
        { provide: IdentityProvider, useValue: identity },
        { provide: APP_GUARD, useClass: FirebaseAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    // Port 0 on loopback: the OS picks a free port; nothing leaves the machine.
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    identity.verifyIdToken.mockReset();
  });

  it('lets @Public() routes through without a token', async () => {
    const res = await get('/t/public');
    expect(res.status).toBe(200);
    expect(identity.verifyIdToken).not.toHaveBeenCalled();
  });

  it('returns 401 without an Authorization header', async () => {
    expect((await get('/t/private')).status).toBe(401);
  });

  it('returns 401 for a non-bearer Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/t/private`, {
      headers: { Authorization: 'Basic abc' },
    });
    expect(res.status).toBe(401);
    expect(identity.verifyIdToken).not.toHaveBeenCalled();
  });

  it.each(['Bearer', 'Bearer ', 'Bearer    ', 'Bearer a b'])(
    'returns 401 for the malformed header %j',
    async (header) => {
      const res = await fetch(`${baseUrl}/api/t/private`, {
        headers: { Authorization: header },
      });
      expect(res.status).toBe(401);
      expect(identity.verifyIdToken).not.toHaveBeenCalled();
    },
  );

  it('accepts a lowercase bearer scheme', async () => {
    identity.verifyIdToken.mockResolvedValue({
      issuedAt: ISSUED,
      uid: 'u1',
      emailVerified: false,
    });

    const res = await fetch(`${baseUrl}/api/t/private`, {
      headers: { Authorization: 'bearer tok' },
    });

    expect(res.status).toBe(200);
    expect(identity.verifyIdToken).toHaveBeenCalledWith('tok');
  });

  it('returns 401 without leaking the provider error', async () => {
    identity.verifyIdToken.mockRejectedValue(
      new Error('auth/id-token-revoked: internal provider detail'),
    );

    const res = await get('/t/private', 'revoked-token');

    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain('Invalid or expired token');
    expect(body).not.toContain('provider detail');
  });

  it('exposes uid, email and role via @CurrentUser()', async () => {
    identity.verifyIdToken.mockResolvedValue({
      issuedAt: ISSUED,
      uid: 'u1',
      email: 'a@example.com',
      emailVerified: true,
    });

    const res = await get('/t/private', 'good-token');

    expect(identity.verifyIdToken).toHaveBeenCalledWith('good-token');
    expect(await res.json()).toEqual({
      uid: 'u1',
      email: 'a@example.com',
      emailVerified: true,
      role: 'user',
      tokenIssuedAt: ISSUED.toISOString(),
    });
  });

  it('treats an unknown role claim as a regular user', async () => {
    identity.verifyIdToken.mockResolvedValue({
      issuedAt: ISSUED,
      uid: 'u1',
      emailVerified: false,
      role: 'ADMIN',
    });

    const res = await get('/t/private', 'token');

    expect(await res.json()).toMatchObject({ role: 'user', email: null });
  });

  it('returns 403 on an admin route for a regular user', async () => {
    identity.verifyIdToken.mockResolvedValue({
      issuedAt: ISSUED,
      uid: 'u1',
      emailVerified: false,
    });
    expect((await get('/t/admin', 'token')).status).toBe(403);
    expect((await get('/admin-class', 'token')).status).toBe(403);
  });

  it('allows an admin route for the admin claim', async () => {
    identity.verifyIdToken.mockResolvedValue({
      issuedAt: ISSUED,
      uid: 'u1',
      emailVerified: false,
      role: 'admin',
    });
    expect((await get('/t/admin', 'token')).status).toBe(200);
    expect((await get('/admin-class', 'token')).status).toBe(200);
  });

  it('returns 401 (not 403) on an admin route without a token', async () => {
    expect((await get('/t/admin')).status).toBe(401);
  });

  it('fails closed for @Roles on a @Public route', async () => {
    expect((await get('/t/misconfigured')).status).toBe(403);
  });
});
