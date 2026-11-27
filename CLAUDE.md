# SaaS Starter (Angular + NestJS)

Production-style SaaS starter: auth, roles, Stripe subscriptions, teams and an admin panel. Its demo app is a link shortener with analytics.

Nx monorepo (npm, integrated layout — tsconfig path aliases, no npm workspaces).

## Stack

- **web** (`apps/web`): Angular 22 — standalone, signals, zoneless (no `zone.js`), esbuild (`@angular/build`), Tailwind v4 via PostCSS, spartan/ui (brain + helm), Vitest.
- **api** (`apps/api`): NestJS 11, native ES modules (`"type": "module"`, webpack ESM output), Vitest (SWC transform for decorator metadata). Global prefix `/api`, port `PORT` (default 3000). Stays on Nest 11 until `@nx/nest` supports Nest 12.
- **shared** (`libs/shared`, `@saas-starter/shared`): types/DTOs used by both apps. Framework-free — no Angular or Nest imports.
- **ui** (`libs/ui/*`, `@spartan-ng/helm/*`): spartan helm primitives, generated and owned by us.
- Planned: Firebase Auth (Google + email), Firestore, Stripe (test mode), roles via custom claims, plans and limits, teams, admin panel. Keys live in `.env` (see `.env.example`).

## Structure

```
apps/web/          Angular app (proxy.conf.json → /api → localhost:3000)
apps/api/          NestJS app
libs/shared/       shared types/DTOs
libs/ui/<name>/    spartan helm components (+ libs/ui/utils)
components.json    spartan CLI config
docs/PLAN.md       architecture plan (planned)
```

Module boundaries are enforced by ESLint tags: `scope:web` → web + shared, `scope:api` → api + shared, `scope:shared` → shared only. The ui libs are tagged `scope:web`. Never import across apps — move shared contracts to `libs/shared`.

## Commands

Always run tasks through Nx (`npx nx …`), not the underlying tools.

```sh
npm start                        # serve api + web (web:serve depends on api:serve)
npx nx serve api                 # api only
npx nx build <project>           # web | api
npx nx test <project>            # web | api | shared (all Vitest)
npx nx lint <project>
npx nx affected -t lint test build
npx nx format:write              # Prettier
npx nx g @spartan-ng/cli:ui <primitive>   # add a spartan component to libs/ui
npx nx g @nx/angular:component …          # prefer Nx generators for scaffolding
```

## Angular conventions

- Standalone components only; no NgModules. Don't set `standalone: true` (it's the default).
- `ChangeDetectionStrategy.OnPush` on every component. App is zoneless — state must flow through signals (or `async` pipe); never rely on zone-triggered change detection, `setTimeout` hacks, or `ChangeDetectorRef.detectChanges()`.
- Signals for state: `signal`, `computed`, `linkedSignal`, `effect` (sparingly — prefer `computed`). Component APIs use `input()`, `output()`, `model()`, `viewChild()` — not decorators.
- `inject()` over constructor injection. HTTP via `httpResource` / `resource` for reads, `HttpClient` for mutations.
- Built-in control flow (`@if`, `@for` with `track`, `@switch`, `@defer`); no `*ngIf`/`*ngFor`.
- Lazy-load feature routes with `loadComponent` / `loadChildren`.
- Styling: Tailwind utilities + spartan theme tokens (`bg-background`, `text-muted-foreground`, …). No per-component CSS files unless unavoidable. Use helm components (`hlmBtn`, …) before building custom UI; check the spartan MCP for APIs.
- Selector prefix `app-` (components) / `app` camelCase (directives).

## NestJS conventions

- One feature module per domain (`apps/api/src/<feature>/{*.module,*.controller,*.service}.ts`). Controllers stay thin; logic lives in services.
- Request/response shapes are defined in `libs/shared` and used as controller return types.
- Validate all input at the boundary (DTO + validation pipe). Never trust client data.
- Config/secrets only via `process.env` through a config module — never hard-code keys, never log them, never return them in responses.
- External providers (Firebase Admin, Stripe) go behind an injectable service interface so they are swappable and mockable in tests.
- Throw Nest `HttpException` subclasses; don't leak stack traces or provider errors to clients.

## Auth and roles (planned — not implemented yet)

The guard and roles land in a later issue. The intended rules, which new code must already be written to fit:

- Every route requires a Firebase ID token (`Authorization: Bearer …`) via a global `FirebaseAuthGuard`. Opt out with `@Public()` (e.g. health, the Stripe webhook, public short-link redirects); read the caller with `@CurrentUser()`.
- Scope all data access to the caller's `uid`, or to their team for team-owned data. Never take a uid or team id from the client without checking membership.
- Roles (e.g. `admin`) come from Firebase custom claims set server-side, never from client input. Admin routes check the claim on the server.

## Stripe (planned)

- **Test mode only.** Use test keys (`sk_test_…`); never add live keys.
- The webhook endpoint must verify the `Stripe-Signature` header with the webhook secret against the **raw** request body; reject unverified events.
- Never trust client-side plan state. The user's or team's plan is synced from Stripe webhooks into the database, and the server enforces plan limits from that record.
- Mock the Stripe SDK in tests — no network calls.

## Testing

- Co-locate specs (`*.spec.ts`). web: Vitest + `TestBed` (use `provideHttpClientTesting()`, `TestBed.tick()` / `fixture.whenStable()` — no zone helpers like `fakeAsync`). api: Vitest + `@nestjs/testing`; shared: plain Vitest. In api/shared, import `describe`/`it`/`expect`/`vi` from `vitest` (no globals).
- Mock external services (Firebase, Stripe) — tests must not hit the network.

## Before finishing any task

1. `npx nx affected -t lint test build` (or the specific projects you touched) — all must pass.
2. `npx nx format:check`.
3. Report failures honestly; don't claim done with red checks.

Before finishing a task, run /review-fix.

## Secrets — never commit them

- Never commit `.env`, API keys, service-account JSON, or `*.pem`. Only `.env.example` (empty values) is tracked.
- Never commit Stripe keys (`sk_…`, `rk_…`) or the Stripe webhook signing secret (`whsec_…`), even test-mode ones.
- Never paste real keys into code, tests, fixtures, docs, or commit messages. New env vars → add an empty entry to `.env.example`.
- Firebase web config is public by design, but still load it from env/build config, not literals.
- Before committing, check `git diff --staged` for anything that looks like a credential.
