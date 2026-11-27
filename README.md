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

### Firebase

Requires the [Firebase CLI](https://firebase.google.com/docs/cli) (`firebase login`) and Java 21+ for the emulators.
The project is set in `.firebaserc`, with Firestore in `europe-west1`.

```sh
npm run firebase:web-config   # writes the web app's public config for local dev (gitignored)
npm run emulators             # Auth :9099, Firestore :8080, emulator UI :4000
```

The web app loads its Firebase config at runtime from `/__/firebase/init.json`. Firebase Hosting serves it in production, and the command above generates it for local dev. Production builds leave the generated file out, so `nx serve-static web` (which serves the production build) can't boot without Hosting; use `npm start` locally. Firestore rules deny all client access: only the api reads and writes, through the Admin SDK.

## License

[MIT](LICENSE) © 2026 Arman Sargsyan
