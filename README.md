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

### Account and settings

The `/settings` page edits the profile, picks the theme and deletes the account.

- **Profile:** `PATCH /api/account/profile { displayName?, photoURL? }` updates the Firebase Auth user and the `users/{uid}` mirror. An empty value clears the field. There's no upload (no Storage bucket): the avatar is an `https://` image URL, and without one the app shows initials.
- **Theme:** light, dark or system, kept in `localStorage` on the device. An inline script in `index.html` applies it (and the `theme-color` the browser UI uses) before first paint; "system" follows the OS setting live, and other tabs follow along.
- **Delete:** `DELETE /api/account` (204) needs a sign-in at most 5 minutes old, otherwise `403 requires_recent_login`; the web app then asks for the password, or a Google popup, and retries. It runs in this order, so a retry after any failure is safe:
  1. Refuses with `409 owns_team_with_members` (listing the teams) while you own a team that has other members. There's no ownership transfer yet: remove the other members first.
  2. Locks each team you own alone (`deletingAt`, re-checking its members in the same transaction). From then on nobody can join it or be invited (`409 team_deleting`). Then it locks your personal workspace the same way. Locked workspaces refuse new checkouts and portal sessions (`409 account_deleting` / `team_deleting`). A lock from an attempt that was given up on lapses after 15 minutes; a retry locks again.
  3. Cancels, at once and without a refund, every Stripe subscription of your personal workspace and of those teams that could still bill (any status but `canceled` and `incomplete_expired`), and expires open checkouts. If Stripe fails, nothing is deleted yet (503). The **Stripe customer is kept**: its invoices are needed for accounting and tax.
  4. Deletes every one of those team docs first (each re-checked in its transaction; invites to them are invalid from then on), then sweeps the teams' and your personal workspace's data: links, click data, workspace docs, subscription mirrors. Short codes stay retired, without anything tying them to you.
  5. Leaves your other teams, revoking the pending invites you sent there, deletes `users/{uid}`, then the Firebase Auth user last.
- **What stays:** the Stripe customer and its invoices; `createdBy` (your uid) on links you created in teams you leave, since those links belong to the team; and admin audit-log entries about your account.
- The deletion runs within the request. A very large workspace (tens of thousands of links) can outlast a proxy timeout; the steps are idempotent, so retrying continues where it stopped. If the request fails with a 401, a 5xx or a network error, the web app asks Firebase (the Identity Toolkit lookup, directly) whether the user still exists: only `USER_NOT_FOUND` counts as deleted, not a revoked session. Otherwise a 401 shows "your session expired, sign in again" (back to `/settings` afterwards), anything else "try again".
- Both routes allow 10 requests per minute per user and are refused in impersonated sessions.

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

## Deploy

The web app goes to **Firebase Hosting** and the api to **Cloud Run**. Hosting serves the Angular build and rewrites `/api/**` and `/r/**` to the Cloud Run service, so the app, the api and short links share one origin (no CORS). `scripts/deploy.sh` does all of it. Every step is idempotent, and `--dry-run` prints the commands without running them.

```
browser ──► Firebase Hosting ──┬─ static files (dist/apps/web/browser)
                               └─ /api/**, /r/** ──► Cloud Run "saas-starter-api" (europe-west1)
                                                      ├─ Firestore, Firebase Auth (service account)
                                                      └─ Stripe (secrets from Secret Manager)
```

The Cloud Run service id and region are set once, in the Hosting rewrites in `firebase.json`, and the script reads them from there.

### Prerequisites

- **Firebase project** on the **Blaze** plan. Cloud Run needs billing, though a low-traffic demo should stay within the free tiers (see Costs).
- **Hosting:** the project's default Hosting site exists. If the first deploy reports there is none, open Hosting in the console and click Get started.
- **Auth:** the Email/Password and Google providers are enabled under Authentication.
- **Web app** registered in the project. Hosting then serves its config at `/__/firebase/init.json`, which the web app loads at startup.
- **CLIs:** `gcloud` (`gcloud auth login`), `firebase` (`firebase login`) and, optionally, the Stripe CLI.
- **Stripe:** a test-mode account with the Pro and Team prices (see Billing above).

### One-time setup

```sh
PROJECT_ID=<your-project-id> scripts/deploy.sh setup
```

Re-running it is safe. It:

- enables the APIs (Cloud Run, Artifact Registry, Cloud Build, Cloud Storage, Secret Manager, IAM, IAM Credentials, Firestore, Hosting, Identity Toolkit)
- creates the Firestore database in `europe-west1` and an Artifact Registry repository that only keeps recent images
- creates the runtime service account `saas-starter-api@…` with `roles/datastore.user`, `roles/firebaseauth.admin`, and token-creator rights on itself (`createCustomToken` signs through the IAM Credentials API, as there's no key file)
- creates a dedicated build service account `saas-starter-build@…`, so images aren't built by the shared Compute Engine default account. It gets only what a build needs:
  - read access to its own source bucket `gs://<project-id>-build-source` (uploads are deleted after 7 days)
  - `roles/artifactregistry.writer` on the one repository
  - `roles/logging.logWriter` (build logs go to Cloud Logging only)
- creates the secrets `stripe-secret-key` (`sk_test_…`) and `stripe-webhook-secret` (`whsec_…`), and grants read access to them only to the runtime account (project Owners and Secret Manager admins can still read them)

Running setup and deploy needs a project Owner, or equivalent roles, including `iam.serviceAccountUser` on both service accounts so that Cloud Build and Cloud Run can run as them.

The secret values are typed at a hidden prompt and piped to `gcloud` on stdin, so they never show up in arguments, shell history or files. Live keys are refused. You can skip the webhook secret at first and re-run setup once the endpoint exists (see below).

### Deploy

```sh
PROJECT_ID=<your-project-id> STRIPE_PRICE_PRO=price_… STRIPE_PRICE_TEAM=price_… scripts/deploy.sh deploy
```

1. **Build:** `nx run-many -t build -p api web`. Both default to production.
2. **Image:** Cloud Build builds `apps/api/Dockerfile` with `apps/api/cloudbuild.yaml`, as the build service account, and pushes it to Artifact Registry tagged with the git sha (`-dirty` if the tree has changes). `BUILDER=docker` builds and pushes from your machine instead, for `linux/amd64`.
3. **Cloud Run:**
   - runs as the runtime service account
   - plain config in env vars: `APP_URL`, `FIREBASE_PROJECT_ID`, `STRIPE_PRICE_*`, `TRUST_PROXY_HOPS=2`
   - Stripe keys from Secret Manager with `--set-secrets`
   - scales from 0 to `MAX_INSTANCES` (default 2)
4. **Firebase:** Firestore rules and indexes (including the clicks TTL), then Hosting.

`APP_URL` defaults to `https://<project-id>.web.app`. With a custom domain, set `APP_URL=https://<domain>`, add the domain to Authentication → Settings → Authorized domains, and register the webhook for it. `scripts/deploy.sh --help` lists every option.

To build and run the image locally: `npx nx docker-build api`, then `docker run -p 3100:8080 -e PORT=8080 …` with the same variables as `.env`.

### Stripe webhook (test mode)

The endpoint is `https://<project-id>.web.app/api/billing/webhook`, so it can be registered before the first deploy. `scripts/deploy.sh webhook` prints the exact command, filling in the API version from `STRIPE_API_VERSION` in `apps/api/src/billing/stripe.client.ts`:

```sh
stripe webhook_endpoints create -d "url=https://<project-id>.web.app/api/billing/webhook" \
  -d "api_version=<STRIPE_API_VERSION>" \
  -d "enabled_events[]=checkout.session.completed" \
  -d "enabled_events[]=customer.subscription.created" \
  -d "enabled_events[]=customer.subscription.updated" \
  -d "enabled_events[]=customer.subscription.deleted" \
  -d "enabled_events[]=invoice.paid" \
  -d "enabled_events[]=invoice.payment_failed"
```

- **API version:** the endpoint must use the version the api pins, not the account default. The api reads fields that older versions don't send, such as the invoice's `parent.subscription_details`.
- **Test mode:** the Stripe CLI uses test mode unless given `--live`, which you should never pass.
- **Dashboard:** the same is Developers → Webhooks → Add endpoint, with test mode on. Pick the same API version there.

Put the endpoint's signing secret into `stripe-webhook-secret` with `scripts/deploy.sh setup`, then deploy again. Secrets are referenced as `:latest` and read when an instance starts, so a deploy rolls every instance onto the new value.

### Client IPs and proxies

Requests reach the api through two proxies: Firebase Hosting, then Cloud Run's front end. Each one appends the address it received the request from to `X-Forwarded-For`, so the api sees `<client>, <hosting>` and trusts exactly two hops (`TRUST_PROXY_HOPS=2`). `req.ip` is then the real client, even if the client sends its own `X-Forwarded-For`. The per-IP click limit, the geoip country and the anonymous rate limits all use it. Called directly on its `*.run.app` URL, Cloud Run is only one hop, and the default of `1` would be right there.

- **Check after the first deploy:**
  - Call `curl https://<app>/r/<code>` 12 times within a minute, each with a different fake `-H 'X-Forwarded-For: …'`. The link's click count should rise by 10, not 12, because the fake header can't change `req.ip`. (The limit is kept in memory per instance, so this assumes one warm instance.)
  - Then open the link from another network, for example a phone on mobile data. That click should still count, which shows `req.ip` isn't Hosting's address.
  - If either check fails, adjust `TRUST_PROXY_HOPS` and deploy again.
- **Known limit:** Hosting rewrites need the service to allow public calls, so the `*.run.app` URL stays reachable. Through it, a client can spoof `X-Forwarded-For` and get around the per-IP click limit and anonymous rate limits. Signed-in limits are per user, and nothing else trusts the IP.

### Security headers and caching

`firebase.json` sets these headers:

- **Security headers:** HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and a restrictive `Permissions-Policy` everywhere.
- **Framing:** `X-Frame-Options: DENY` and a CSP limited to `frame-ancestors 'none'; base-uri 'self'; object-src 'none'`, on every path except Firebase's reserved `/__/…`. The Google sign-in popup loads `/__/auth/iframe` from the same Hosting site in a hidden iframe, so framing it must stay allowed. The rule is a regex that skips paths starting with `/__`.
- **Caching:**
  - Hashed `*.js`/`*.css` files are cached for a year as `immutable`.
  - HTML (including SPA routes) is `no-cache`, so a deploy shows up on the next page load.
  - The api marks every `/api` response `Cache-Control: no-store` itself, and the redirect does the same for `/r/…`.
  - `firebase.json` repeats `no-store` for `/api/**` and `/r/**`. That keeps the site-wide `no-cache` default from replacing it, in case Hosting applies its headers to rewritten responses.

A full `script-src`/`connect-src` CSP is **deferred**. Firebase Auth's Google popup needs `apis.google.com`, `*.firebaseapp.com`, `identitytoolkit` and `securetoken`, and Angular injects inline styles. Such a policy has to be tested against the deployed app, preferably in `Content-Security-Policy-Report-Only` first.

### Verify

```sh
curl -fsS https://<project-id>.web.app/api/health          # {"status":"ok",…}
curl -sI https://<project-id>.web.app/api/health | grep -i cache-control   # no-store
curl -sI https://<project-id>.web.app/r/does-not-exist     # 404 from the api
curl -sI https://<project-id>.web.app/dashboard | grep -i x-frame-options  # DENY
gcloud run services logs read saas-starter-api --region=europe-west1 --project=<project-id> --limit=50
```

Then check sign-up and log-in with email and with Google. Google uses a popup and a hidden `/__/auth/iframe`, which is the first thing a wrong frame header breaks. Then create a link, open its short URL, and run a test checkout with `4242 4242 4242 4242`. The plan changes once the webhook arrives, which the Stripe Dashboard shows under the endpoint's deliveries. To grant admin on the deployed project, run `npx nx grant-admin api -- <email>` with `FIREBASE_PROJECT_ID=<project-id>` and Application Default Credentials (`gcloud auth application-default login`).

### Costs

A demo with little traffic should cost nothing or a few cents a month. Free tiers change, so check current pricing, and set a budget alert under Billing → Budgets.

- **Cloud Run:** scales to zero, with a monthly free allowance of requests, CPU and memory. `--max-instances=2` caps the worst case.
- **Firebase Hosting:** free storage and transfer allowances.
- **Firestore:** daily free reads, writes and deletes, plus 1 GiB of storage.
- **Secret Manager:** a few active secret versions and 10,000 accesses a month are free. Secrets are read only when an instance starts.
- **Artifact Registry:** 0.5 GB of free storage. The cleanup policy keeps the last 5 images and deletes others after 30 days.
- **Cloud Build:** a free allowance of build minutes. Each deploy builds one small image. The source bucket deletes uploads after 7 days.

### Tear down

```sh
gcloud run services delete saas-starter-api --region=europe-west1 --project=<project-id>
firebase hosting:disable --project=<project-id>
gcloud artifacts repositories delete saas-starter --location=europe-west1 --project=<project-id>
gcloud secrets delete stripe-secret-key --project=<project-id>
gcloud secrets delete stripe-webhook-secret --project=<project-id>
gcloud storage rm --recursive gs://<project-id>-build-source
# Project-level roles from setup (bucket, repo, secret and self bindings go with those resources):
gcloud projects remove-iam-policy-binding <project-id> --condition=None \
  --member=serviceAccount:saas-starter-api@<project-id>.iam.gserviceaccount.com --role=roles/datastore.user
gcloud projects remove-iam-policy-binding <project-id> --condition=None \
  --member=serviceAccount:saas-starter-api@<project-id>.iam.gserviceaccount.com --role=roles/firebaseauth.admin
gcloud projects remove-iam-policy-binding <project-id> --condition=None \
  --member=serviceAccount:saas-starter-build@<project-id>.iam.gserviceaccount.com --role=roles/logging.logWriter
gcloud iam service-accounts delete saas-starter-api@<project-id>.iam.gserviceaccount.com --project=<project-id>
gcloud iam service-accounts delete saas-starter-build@<project-id>.iam.gserviceaccount.com --project=<project-id>
stripe webhook_endpoints delete we_…        # the endpoint id from `stripe webhook_endpoints list`
```

Or delete the whole project with `gcloud projects delete <project-id>`, which also removes every resource, service account and role binding above.

## License

[MIT](LICENSE) © 2026 Arman Sargsyan
