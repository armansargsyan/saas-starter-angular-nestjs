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
cp .env.example .env                   # fill in; the api refuses to boot on invalid config
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

**Sign-in against the emulators (no real accounts):**

```sh
npm run emulators                       # Auth :9099, Firestore :8080
npm run firebase:web-config:emulator    # points the web app at the Auth emulator (dev builds only)
# api: add FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 and FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 to .env
npm start
```

- Verification and reset emails are not sent: their links are listed by the emulator at `http://127.0.0.1:9099/emulator/v1/projects/<project>/oobCodes`.
- Run `npm run firebase:web-config` to switch back to the real project.

**Web app routes:**

- `/login` and `/signup` (email/password or Google) send signed-in users to the dashboard.
- `/reset-password` sends a Firebase reset email.
- `/verify-email` is for password accounts.
- Signed-in pages redirect to `/login?redirect=…`.
- Admin pages also need the `admin` claim. The api checks every admin call itself, too.

### Auth and roles

- **Authentication:** every api route needs a Firebase ID token (`Authorization: Bearer …`). Routes opt out with `@Public()`. Read the caller with `@CurrentUser()`, which gives `uid`, `email`, `emailVerified` and `role`. Anything that grants access by email must check `emailVerified`.
- **Admin routes:** restricted with `@Roles('admin')`. The role comes from the `role` custom claim.
- **Credentials:** the api verifies tokens with a revocation check, so it needs Admin credentials. Locally that means `gcloud auth application-default login`, or running against the emulators with `FIREBASE_AUTH_EMULATOR_HOST` / `FIRESTORE_EMULATOR_HOST` set.
- **Granting admin:**

  ```sh
  npx nx grant-admin api -- someone@example.com            # grant admin
  npx nx grant-admin api -- someone@example.com --revoke   # back to user
  ```

  - **Verified emails only:** granting refuses an unverified email, since anyone can sign up with an address they don't own. Pass `--force` after checking the account the script prints.
  - **Granting** takes effect when the user's ID token refreshes.
  - **Revoking** also revokes their sessions, so it takes effect at once.
  - **Audit log:** every change is written to `auditLog`.

### Links api

| Method and path                                       | What it does                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `POST /api/workspaces/:workspaceId/links`             | Create a link: `{ targetUrl, title?, slug? }`. Limited to 30 per minute per user. |
| `GET /api/workspaces/:workspaceId/links?limit&cursor` | List links, newest first.                                                         |
| `GET` / `PATCH` / `DELETE /api/links/:code`           | Read, update (`targetUrl`, `title`) or delete one link.                           |
| `GET /api/links/:code/stats?days=30`                  | Clicks per day, top referrers and countries, devices (up to 90 days).             |
| `GET /r/:code`                                        | Public. 302 redirect that records the click; unknown codes get a 404 page.        |

- **Workspaces:** your personal workspace id is your uid. Links in a workspace you can't access return 404.
- **Click data:** each click stores only the referrer host, the country and the device type, never the IP. The country comes from an offline geoip-lite lookup.
- **Bots** are counted separately.
- **Inflation guard:** each IP counts at most 10 clicks per link per minute. Clicks over the limit still redirect, they just aren't counted.
- **Raw clicks** expire after 90 days through a Firestore TTL policy.

### Plans and limits

Plans are defined once, in `libs/shared` (`PLANS`):

| Plan | Links     | Members | Price  |
| ---- | --------- | ------- | ------ |
| Free | 10        | 1       | $0     |
| Pro  | unlimited | 1       | $9/mo  |
| Team | unlimited | 10      | $29/mo |

- **Enforced by the api:** the link-create transaction checks the workspace's stored `linkCount` against its effective plan, so concurrent requests can't overshoot the limit. At the limit the api returns `403 { code: 'plan_limit_reached', resource, limit, plan }`.
- **Downgrades:** existing links keep working, but new ones are blocked until the workspace is back under the limit.
- **Usage for the UI:** `GET /api/usage?workspaceId=…` returns `{ plan, links: { used, limit }, members: { used, limit } }`, where `limit: null` means unlimited.
- **Error codes:** machine-readable error codes are listed in `libs/shared` (`API_ERROR_CODES`).

### Billing (Stripe, test mode only)

| Endpoint                                                              | What it does                                                                                                                |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/billing/checkout` `{ workspaceId, plan: 'pro' \| 'team' }` | Returns `{ url }` for Stripe Checkout. Only the workspace owner can call it: Pro for a personal workspace, Team for a team. |
| `POST /api/billing/portal` `{ workspaceId }`                          | Returns `{ url }` for the Stripe customer portal (change plan, cancel, payment method).                                     |
| `GET /api/billing/invoices?workspaceId=…`                             | The customer's invoices, with links to Stripe's hosted invoice pages.                                                       |
| `POST /api/billing/webhook`                                           | Public. Checks the `Stripe-Signature` header against the raw request body.                                                  |

- **The plan comes only from webhooks.** For each event the api re-fetches the subscription from Stripe and writes `workspace.plan` and `subscriptions/{id}`.
- **Duplicate events are skipped**, using the event id stored in `stripeEvents/{id}`.
- **Handled events:** checkout completed, subscription created/updated/deleted, and invoice paid/failed. Other events are acknowledged and ignored.

**Local setup.** You need a Stripe test-mode account and the [Stripe CLI](https://docs.stripe.com/stripe-cli).

```sh
stripe login
# Create two monthly prices (Pro $9, Team $29) and put their ids in .env:
stripe prices create --unit-amount 900  --currency usd --recurring.interval month --product-data.name "Pro"
stripe prices create --unit-amount 2900 --currency usd --recurring.interval month --product-data.name "Team"
# Forward webhooks to the local api; copy the printed whsec_… into STRIPE_WEBHOOK_SECRET:
stripe listen --forward-to localhost:3000/api/billing/webhook
```

Pay with the test card `4242 4242 4242 4242`, using any future expiry date and any CVC. In the Stripe dashboard, enable the customer portal under Settings → Billing → Customer portal.

- **Plan switching:** don't let the portal switch between the Pro and Team products. Pro belongs to personal workspaces and Team to teams, and the webhook ignores a plan that doesn't fit the workspace.
- **Live mode:** live-mode events are ignored. The api only runs in test mode.

### Teams

- **Create:** `POST /api/teams { name }`. The creator becomes the owner. Adding members needs the Team plan (up to 10 seats), bought through billing checkout for the team.
- **Invite:** `POST /api/teams/:id/invites { email, role }` returns `{ invite, acceptUrl }`.
  - The token is `<teamId>.<inviteId>.<256-bit secret>`. Only the secret's SHA-256 is stored, and invites expire after 7 days.
  - No email provider is set up yet: the inviter shares `acceptUrl`, and `InviteMailer` is where one plugs in.
- **Accept:** the invitee opens `<APP_URL>/invite#token=…`, signs in, then calls `POST /api/invites/preview|accept|decline { token }`. The token sits in the URL fragment and in request bodies, never in a query string, so it stays out of server logs and `Referer` headers.
  - Accepting needs a **verified** email that matches the invite.
  - Seats are checked in the same transaction that adds the member.
  - Invite endpoints allow 20 requests per minute per user. Creating teams and sending invites share a limit of 30 per minute.
  - Removing members, inviting and revoking re-check the caller's role inside the transaction, so a just-demoted admin can't finish a write.
- **Manage:** `GET /api/teams/:id/members`, `PATCH /api/teams/:id/members/:uid { role }`, `DELETE /api/teams/:id/members/:uid` (remove someone, or leave yourself), and `DELETE /api/teams/:id/invites/:inviteId` (revoke).

| Permission                                                     | Owner | Admin | Member |
| -------------------------------------------------------------- | :---: | :---: | :----: |
| Billing, changing roles, inviting admins                       |   ✓   |       |        |
| Inviting members, removing members, revoking invites, renaming |   ✓   |   ✓   |        |
| Team links, member list                                        |   ✓   |   ✓   |   ✓    |

Non-members get a 404 on every team route. Team links use the same membership check, so removing someone takes away their access at once.

### Admin api

Every route under `/api/admin` needs the `admin` custom claim (`npx nx grant-admin api -- <email>`).

| Endpoint                                   | What it does                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/admin/users?q=&limit=&cursor=`   | Users, searchable by email prefix, with plan, link count and status.                                                                                                                 |
| `GET /api/admin/users/:uid`                | One user.                                                                                                                                                                            |
| `POST /api/admin/users/:uid/ban` / `unban` | Disables or re-enables the Firebase user. A ban also revokes their sessions, so the api's revocation check rejects even tokens they still hold.                                      |
| `POST /api/admin/users/:uid/impersonate`   | Returns `{ customToken, expiresAt }` for `signInWithCustomToken`.                                                                                                                    |
| `GET /api/admin/stats?days=30`             | MRR per currency (active and past_due subscriptions, normalized to monthly), live subscriptions (active, trialing, past_due) by plan, and signups per day (one count query per day). |

- **Impersonated sessions** carry `impersonatedBy` in the token, which `GET /api/auth/me` shows. They are **read-only** (any write returns `403 impersonation_read_only`), never have admin rights, and end 30 minutes after the token was minted (or after sign-in, if that comes first).
- **Protected users:** admins can't be banned or impersonated, and neither can you yourself.
- **Audit log:** every ban, unban and impersonation is written to `auditLog`, first as `pending`, then marked `applied` or `failed`, together with the steps that completed.

## License

[MIT](LICENSE) © 2026 Arman Sargsyan
