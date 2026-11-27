import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { configureApp } from '../app/configure-app';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { IdentityProvider } from '../firebase/identity.provider';
import { WorkspacesRepository } from '../workspaces/workspaces.repository';
import { UsageModule } from './usage.module';

@Global()
@Module({
  providers: [
    {
      provide: IdentityProvider,
      useValue: {
        verifyIdToken: async (token: string) => ({
          uid: token,
          emailVerified: true,
          issuedAt: new Date(),
        }),
      },
    },
  ],
  exports: [IdentityProvider],
})
class FakeIdentityModule {}

describe('GET /api/usage', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeIdentityModule, UsageModule],
      providers: [{ provide: APP_GUARD, useClass: FirebaseAuthGuard }],
    })
      .overrideProvider(WorkspacesRepository)
      .useValue({
        isMember: vi.fn().mockResolvedValue(false),
        getUsage: vi
          .fn()
          .mockResolvedValue({ plan: null, linkCount: 3, memberCount: 1 }),
      })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app, { trustProxyHops: 1 });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (query: string, as?: string) =>
    fetch(`${baseUrl}/api/usage${query}`, {
      headers: as ? { Authorization: `Bearer ${as}` } : {},
    });

  it('returns usage for your own workspace', async () => {
    const res = await get('?workspaceId=alice', 'alice');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspaceId: 'alice',
      plan: 'free',
      links: { used: 3, limit: 10 },
      members: { used: 1, limit: 1 },
    });
  });

  it('requires auth, a valid workspaceId and access', async () => {
    expect((await get('?workspaceId=alice')).status).toBe(401);
    expect((await get('', 'alice')).status).toBe(400);
    expect((await get('?workspaceId=a%2Fb', 'alice')).status).toBe(400);
    expect((await get('?workspaceId=bob', 'alice')).status).toBe(404);
  });
});
