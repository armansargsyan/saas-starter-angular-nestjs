import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { MeResponse } from '@saas-starter/shared';
import { IdentityProvider } from '../firebase/identity.provider';
import { WorkspacesRepository } from '../workspaces/workspaces.repository';
import { AuthModule } from './auth.module';
import { UsersRepository } from './users.repository';

describe('GET /api/auth/me', () => {
  let app: INestApplication;
  let baseUrl: string;

  const identity = {
    verifyIdToken: vi.fn().mockResolvedValue({
      uid: 'u1',
      email: 'a@example.com',
      emailVerified: true,
      issuedAt: new Date(),
      role: 'admin',
    }),
    getUser: vi.fn(),
  };

  beforeAll(async () => {
    // Stands in for the global FirebaseModule.
    @Global()
    @Module({
      providers: [{ provide: IdentityProvider, useValue: identity }],
      exports: [IdentityProvider],
    })
    class FakeFirebaseModule {}

    // The real AuthModule (guards included), with Firebase and Firestore mocked.
    const moduleRef = await Test.createTestingModule({
      imports: [FakeFirebaseModule, AuthModule],
    })
      .overrideProvider(UsersRepository)
      .useValue({
        get: vi.fn().mockResolvedValue({
          uid: 'u1',
          email: 'a@example.com',
          displayName: 'Ada',
          photoURL: null,
          role: 'admin',
          status: 'active',
          roleChangedAt: null,
        }),
        createIfAbsent: vi.fn(),
        setRole: vi.fn(),
      })
      .overrideProvider(WorkspacesRepository)
      .useValue({ getPlan: vi.fn().mockResolvedValue(null) })
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 401 without a token', async () => {
    expect((await fetch(`${baseUrl}/api/auth/me`)).status).toBe(401);
  });

  it('returns the profile, role and plan', async () => {
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as MeResponse).toEqual({
      uid: 'u1',
      email: 'a@example.com',
      displayName: 'Ada',
      photoURL: null,
      role: 'admin',
      plan: 'free',
    });
  });
});
