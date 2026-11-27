# SaaS Starter (Angular + NestJS)

A production-style SaaS starter (auth, roles, Stripe subscriptions, teams, admin panel), with a link shortener with analytics as its demo app.

**Status:** in progress.

## Stack

- **Nx 24** monorepo (npm, integrated layout)
- **web:** Angular 22 (standalone, signals, zoneless, esbuild), Tailwind v4, spartan/ui
- **api:** NestJS 11 (native ES modules)
- **libs/shared:** types and DTOs shared by both apps
- **Tests:** Vitest everywhere
- **Planned:** Firebase Auth + Firestore, Stripe (test mode)

The architecture plan will live in `docs/PLAN.md`.

## Run locally

Requires Node 24.

```sh
npm ci
npm start                              # api on :3000, web on :4200 (proxies /api)
npx nx run-many -t lint test build     # all checks
```

## License

[MIT](LICENSE) © 2026 Arman Sargsyan
