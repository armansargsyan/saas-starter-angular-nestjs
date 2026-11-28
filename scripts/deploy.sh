#!/usr/bin/env bash
# Deploys the demo: api → Cloud Run, web → Firebase Hosting (with /api/** and
# /r/** rewritten to Cloud Run), plus Firestore rules and indexes.
#
#   PROJECT_ID=my-project scripts/deploy.sh setup     # one time (safe to re-run)
#   PROJECT_ID=my-project STRIPE_PRICE_PRO=price_… STRIPE_PRICE_TEAM=price_… \
#     scripts/deploy.sh deploy
#   scripts/deploy.sh deploy --dry-run                # print the commands only
#
# Every step is idempotent. See the README ("Deploy") for the full walkthrough.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/deploy.sh <setup|deploy|webhook> [--dry-run]

  setup    One time, safe to re-run: enable APIs, create the Firestore database,
           the Artifact Registry repo, the runtime and Cloud Build service
           accounts with their roles, the build source bucket, and the Stripe
           secrets in Secret Manager (typed at a hidden prompt and piped on
           stdin, never echoed or passed as arguments).
  deploy   Build with Nx, build and push the api image, deploy Cloud Run, then
           Firestore rules/indexes and Hosting.
  webhook  Print how to register the Stripe test-mode webhook for this deploy.

  --dry-run  Print every command instead of running it (no cloud access).

Environment:
  PROJECT_ID         required: the Firebase / Google Cloud project id
  APP_URL            public origin (default: https://$PROJECT_ID.web.app)
  STRIPE_PRICE_PRO   required for deploy: price_… of the Pro plan (test mode)
  STRIPE_PRICE_TEAM  required for deploy: price_… of the Team plan (test mode)
  REPOSITORY         Artifact Registry repository (default: saas-starter)
  RUNTIME_SA_NAME    runtime service account id (default: saas-starter-api)
  BUILD_SA_NAME      Cloud Build service account id (default: saas-starter-build)
  BUILD_BUCKET       bucket for Cloud Build sources (default: $PROJECT_ID-build-source)
  MAX_INSTANCES      Cloud Run max instances, a cost cap (default: 2)
  TRUST_PROXY_HOPS   proxies in front of the api (default: 2, see README)
  BUILDER            cloud-build (default) or docker (local buildx push)
  IMAGE_TAG          image tag (default: git short sha, +"-dirty" if modified)

The Cloud Run service id and region come from the Hosting rewrites in
firebase.json, so the two can't drift apart.
EOF
}

# ── Arguments ─────────────────────────────────────────────────
COMMAND=""
DRY_RUN="${DRY_RUN:-0}"
for arg in "$@"; do
  case "$arg" in
    setup | deploy | webhook) COMMAND="$arg" ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done
if [[ -z "$COMMAND" ]]; then
  usage >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# Prints a command, then runs it unless --dry-run.
run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [[ "$DRY_RUN" != 1 ]]; then
    "$@"
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is not installed ($2)"
}

# ── Configuration ─────────────────────────────────────────────
: "${PROJECT_ID:?set PROJECT_ID to your Firebase / Google Cloud project id}"

# Prints a string setting from firebase.json; fails if it's missing.
#   read_firebase_json run.serviceId   (the Cloud Run rewrite's serviceId)
#   read_firebase_json firestore.location
read_firebase_json() {
  node -e '
    const config = require("./firebase.json");
    const [scope, key] = process.argv[1].split(".");
    const parent = scope === "run"
      ? config.hosting?.rewrites?.find((r) => r.run)?.run
      : config[scope];
    const value = parent?.[key];
    if (typeof value !== "string" || value === "") process.exit(1);
    process.stdout.write(value);
  ' "$1"
}
SERVICE="$(read_firebase_json run.serviceId)" || die "no Cloud Run rewrite serviceId in firebase.json"
REGION="$(read_firebase_json run.region)" || die "no Cloud Run rewrite region in firebase.json"
FIRESTORE_LOCATION="$(read_firebase_json firestore.location)" || die "no firestore.location in firebase.json"

# The Stripe API version the api pins; the webhook endpoint must send events
# in the same shape (e.g. invoice.parent.subscription_details).
STRIPE_API_VERSION="$(sed -n "s/^export const STRIPE_API_VERSION = '\([^']*\)'.*/\1/p" \
  apps/api/src/billing/stripe.client.ts)"
[[ -n "$STRIPE_API_VERSION" ]] || die "STRIPE_API_VERSION not found in apps/api/src/billing/stripe.client.ts"

APP_URL="${APP_URL:-https://${PROJECT_ID}.web.app}"
APP_URL="${APP_URL%/}"
REPOSITORY="${REPOSITORY:-saas-starter}"
RUNTIME_SA_NAME="${RUNTIME_SA_NAME:-saas-starter-api}"
RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
BUILD_SA_NAME="${BUILD_SA_NAME:-saas-starter-build}"
BUILD_SA="${BUILD_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
BUILD_BUCKET="${BUILD_BUCKET:-${PROJECT_ID}-build-source}"
MAX_INSTANCES="${MAX_INSTANCES:-2}"
TRUST_PROXY_HOPS="${TRUST_PROXY_HOPS:-2}"
BUILDER="${BUILDER:-cloud-build}"

# Scratch space for generated files, removed on any exit (including errors).
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Secret Manager secret → env var of the api.
SECRET_STRIPE_KEY="stripe-secret-key"
SECRET_STRIPE_WEBHOOK="stripe-webhook-secret"

WEBHOOK_URL="${APP_URL}/api/billing/webhook"
WEBHOOK_EVENTS=(
  checkout.session.completed
  customer.subscription.created
  customer.subscription.updated
  customer.subscription.deleted
  invoice.paid
  invoice.payment_failed
)

print_config() {
  cat <<EOF
Project:          $PROJECT_ID
Region:           $REGION (Cloud Run; Firestore: $FIRESTORE_LOCATION)
Cloud Run:        $SERVICE (runs as $RUNTIME_SA)
Artifact repo:    ${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}
Cloud Build:      runs as $BUILD_SA, source in gs://$BUILD_BUCKET
App URL:          $APP_URL
Stripe webhook:   $WEBHOOK_URL (API version $STRIPE_API_VERSION)
Dry run:         $([[ "$DRY_RUN" == 1 ]] && echo yes || echo no)
EOF
}

# ── webhook ───────────────────────────────────────────────────
print_webhook_steps() {
  local event
  cat <<EOF

Stripe webhook (test mode only)
  Endpoint:    $WEBHOOK_URL
  API version: $STRIPE_API_VERSION (pinned in apps/api/src/billing/stripe.client.ts)
  Events:      ${WEBHOOK_EVENTS[*]}

  With the Stripe CLI (test mode is its default; never pass --live):
    stripe webhook_endpoints create -d "url=${WEBHOOK_URL}" \\
      -d "api_version=${STRIPE_API_VERSION}" \\
EOF
  for event in "${WEBHOOK_EVENTS[@]}"; do
    printf '      -d "enabled_events[]=%s" \\\n' "$event"
  done
  cat <<EOF
      -d "description=saas-starter demo"
  Or in the Dashboard, in test mode: Developers → Webhooks → Add endpoint,
  with the URL and events above, and API version $STRIPE_API_VERSION (not
  the account default: the api reads fields that older versions don't send).

  Its signing secret (whsec_…, shown on the endpoint) goes into Secret
  Manager when "scripts/deploy.sh setup" asks for it (input hidden). After
  changing a secret, re-run deploy so every instance picks it up.
EOF
}

# ── setup ─────────────────────────────────────────────────────
secret_exists() {
  gcloud secrets describe "$1" --project="$PROJECT_ID" >/dev/null 2>&1
}

# True when the newest version (what ":latest" resolves to) is ENABLED, not
# missing, disabled or destroyed.
secret_has_version() {
  local state
  state="$(gcloud secrets versions describe latest --secret="$1" --project="$PROJECT_ID" \
    --format='value(state)' 2>/dev/null)" || return 1
  [[ "$state" == ENABLED ]]
}

# Creates the secret if missing and adds a version typed into the terminal
# (hidden, piped to gcloud on stdin). An existing value is kept unless the
# user asks to replace it; an empty answer skips the secret for now.
ensure_secret() {
  local name="$1" prefix="$2" label="$3"
  local value answer
  if [[ "$DRY_RUN" == 1 ]]; then
    run gcloud secrets create "$name" --replication-policy=automatic --project="$PROJECT_ID"
    printf '+ (hidden prompt for %s) | gcloud secrets versions add %s --data-file=- --project=%s\n' \
      "$label" "$name" "$PROJECT_ID"
    return
  fi
  if ! secret_exists "$name"; then
    run gcloud secrets create "$name" --replication-policy=automatic --project="$PROJECT_ID"
  elif secret_has_version "$name"; then
    read -r -p "Secret $name already has a value. Replace it? [y/N] " answer ||
      die "setup needs an interactive terminal"
    [[ "$answer" =~ ^[Yy]$ ]] || return 0
  fi
  read -r -s -p "Paste $label ($prefix…), or press Enter to skip for now: " value ||
    die "setup needs an interactive terminal"
  printf '\n'
  if [[ -z "$value" ]]; then
    echo "Skipped $name: re-run setup before deploying."
    return 0
  fi
  [[ "$value" == "$prefix"?* ]] || die "$name must start with $prefix (test mode only)"
  printf '+ (hidden value) | gcloud secrets versions add %s --data-file=-\n' "$name"
  printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- --project="$PROJECT_ID"
  unset value
}

grant_secret_access() {
  run gcloud secrets add-iam-policy-binding "$1" --project="$PROJECT_ID" \
    --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor \
    --condition=None --quiet
}

cmd_setup() {
  require_cmd gcloud "https://cloud.google.com/sdk/docs/install"

  log "Enabling APIs"
  run gcloud services enable --project="$PROJECT_ID" \
    run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
    storage.googleapis.com secretmanager.googleapis.com iam.googleapis.com \
    iamcredentials.googleapis.com \
    firestore.googleapis.com firebasehosting.googleapis.com identitytoolkit.googleapis.com

  log "Firestore database ($FIRESTORE_LOCATION)"
  if [[ "$DRY_RUN" == 1 ]] ||
    ! gcloud firestore databases describe --database='(default)' --project="$PROJECT_ID" >/dev/null 2>&1; then
    run gcloud firestore databases create --database='(default)' \
      --location="$FIRESTORE_LOCATION" --type=firestore-native --project="$PROJECT_ID"
  else
    echo "exists"
  fi

  log "Artifact Registry repository $REPOSITORY"
  if [[ "$DRY_RUN" == 1 ]] ||
    ! gcloud artifacts repositories describe "$REPOSITORY" --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
    run gcloud artifacts repositories create "$REPOSITORY" --repository-format=docker \
      --location="$REGION" --project="$PROJECT_ID" --description="saas-starter images"
  else
    echo "exists"
  fi
  # Keep storage (and cost) small: images older than 30 days are deleted,
  # except the 5 most recent. (gcloud takes the policy only as a file.)
  local policy="$WORK_DIR/cleanup-policy.json"
  cat >"$policy" <<'EOF'
[{"name": "keep-recent", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 5}},
 {"name": "delete-old", "action": {"type": "Delete"}, "condition": {"tagState": "any", "olderThan": "30d"}}]
EOF
  run gcloud artifacts repositories set-cleanup-policies "$REPOSITORY" \
    --location="$REGION" --project="$PROJECT_ID" --policy="$policy" --no-dry-run --quiet

  log "Runtime service account $RUNTIME_SA"
  if [[ "$DRY_RUN" == 1 ]] ||
    ! gcloud iam service-accounts describe "$RUNTIME_SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
    run gcloud iam service-accounts create "$RUNTIME_SA_NAME" --project="$PROJECT_ID" \
      --display-name="saas-starter api (Cloud Run)"
  else
    echo "exists"
  fi
  # Firestore read/write and Firebase Auth admin (verify tokens, claims, bans).
  local role
  for role in roles/datastore.user roles/firebaseauth.admin; do
    run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
      --member="serviceAccount:${RUNTIME_SA}" --role="$role" --condition=None --quiet
  done
  # createCustomToken (admin impersonation) signs with the account's own key
  # through the IAM Credentials API, as there is no key file on Cloud Run.
  run gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --project="$PROJECT_ID" \
    --member="serviceAccount:${RUNTIME_SA}" --role=roles/iam.serviceAccountTokenCreator \
    --condition=None --quiet

  log "Cloud Build service account $BUILD_SA"
  # A dedicated account instead of the shared Compute Engine default one, with
  # only what the build needs: read its source bucket, push to this one
  # repository, and write logs (the build config logs to Cloud Logging only).
  if [[ "$DRY_RUN" == 1 ]] ||
    ! gcloud iam service-accounts describe "$BUILD_SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
    run gcloud iam service-accounts create "$BUILD_SA_NAME" --project="$PROJECT_ID" \
      --display-name="saas-starter image builds (Cloud Build)"
  else
    echo "exists"
  fi
  if [[ "$DRY_RUN" == 1 ]] ||
    ! gcloud storage buckets describe "gs://${BUILD_BUCKET}" --project="$PROJECT_ID" >/dev/null 2>&1; then
    run gcloud storage buckets create "gs://${BUILD_BUCKET}" --project="$PROJECT_ID" \
      --location="$REGION" --uniform-bucket-level-access --public-access-prevention
  else
    echo "bucket gs://${BUILD_BUCKET} exists"
  fi
  # Uploaded build sources are only needed while a build runs.
  local lifecycle="$WORK_DIR/lifecycle.json"
  echo '{"rule": [{"action": {"type": "Delete"}, "condition": {"age": 7}}]}' >"$lifecycle"
  run gcloud storage buckets update "gs://${BUILD_BUCKET}" --project="$PROJECT_ID" \
    --lifecycle-file="$lifecycle"
  run gcloud storage buckets add-iam-policy-binding "gs://${BUILD_BUCKET}" --project="$PROJECT_ID" \
    --member="serviceAccount:${BUILD_SA}" --role=roles/storage.objectViewer
  run gcloud artifacts repositories add-iam-policy-binding "$REPOSITORY" \
    --location="$REGION" --project="$PROJECT_ID" \
    --member="serviceAccount:${BUILD_SA}" --role=roles/artifactregistry.writer
  run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${BUILD_SA}" --role=roles/logging.logWriter --condition=None --quiet

  log "Stripe secrets (test mode)"
  ensure_secret "$SECRET_STRIPE_KEY" "sk_test_" "the Stripe test secret key"
  print_webhook_steps
  ensure_secret "$SECRET_STRIPE_WEBHOOK" "whsec_" "the webhook signing secret"
  grant_secret_access "$SECRET_STRIPE_KEY"
  grant_secret_access "$SECRET_STRIPE_WEBHOOK"

  log "Setup done. Next: scripts/deploy.sh deploy"
}

# ── deploy ────────────────────────────────────────────────────
cmd_deploy() {
  require_cmd node "https://nodejs.org"
  require_cmd gcloud "https://cloud.google.com/sdk/docs/install"
  require_cmd firebase "npm install -g firebase-tools"
  : "${STRIPE_PRICE_PRO:?set STRIPE_PRICE_PRO (price_… of the Pro plan, test mode)}"
  : "${STRIPE_PRICE_TEAM:?set STRIPE_PRICE_TEAM (price_… of the Team plan, test mode)}"
  [[ "$STRIPE_PRICE_PRO" == price_?* && "$STRIPE_PRICE_TEAM" == price_?* ]] ||
    die "STRIPE_PRICE_PRO and STRIPE_PRICE_TEAM must be price ids (price_…)"
  [[ "$APP_URL" == https://* ]] || die "APP_URL must be https"

  if [[ "$DRY_RUN" != 1 ]]; then
    local name
    for name in "$SECRET_STRIPE_KEY" "$SECRET_STRIPE_WEBHOOK"; do
      secret_has_version "$name" ||
        die "secret $name has no value in $PROJECT_ID; run: PROJECT_ID=$PROJECT_ID scripts/deploy.sh setup"
    done
  fi

  local tag="${IMAGE_TAG:-}"
  if [[ -z "$tag" ]]; then
    tag="$(git rev-parse --short HEAD)"
    # Uncommitted or untracked changes end up in the build too.
    [[ -z "$(git status --porcelain)" ]] || tag="${tag}-dirty"
  fi
  local image="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${SERVICE}:${tag}"

  log "Building api and web"
  # Both builds default to production (api: NODE_ENV=production; web: the
  # production configuration).
  run npx nx run-many -t build -p api web

  log "Building and pushing $image"
  # The image context is the api build output (see apps/api/Dockerfile).
  run cp apps/api/Dockerfile dist/apps/api/Dockerfile
  run cp apps/api/Dockerfile.dockerignore dist/apps/api/.dockerignore
  case "$BUILDER" in
    cloud-build)
      run cp apps/api/cloudbuild.yaml dist/apps/api/cloudbuild.yaml
      run gcloud builds submit dist/apps/api --config=dist/apps/api/cloudbuild.yaml \
        --substitutions="_IMAGE=${image}" \
        --service-account="projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA}" \
        --gcs-source-staging-dir="gs://${BUILD_BUCKET}/source" \
        --region="$REGION" --project="$PROJECT_ID" --quiet
      ;;
    docker)
      require_cmd docker "https://docs.docker.com/get-docker/"
      run gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
      # Cloud Run runs linux/amd64, whatever the local machine is.
      run docker buildx build --platform=linux/amd64 --push -t "$image" dist/apps/api
      ;;
    *) die "BUILDER must be cloud-build or docker" ;;
  esac

  log "Deploying Cloud Run service $SERVICE"
  # Secrets come from Secret Manager; everything else is plain config. PORT
  # is set by Cloud Run itself.
  run gcloud run deploy "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
    --image="$image" \
    --service-account="$RUNTIME_SA" \
    --allow-unauthenticated \
    --ingress=all \
    --cpu=1 --memory=512Mi --concurrency=80 --timeout=60s \
    --min-instances=0 --max-instances="$MAX_INSTANCES" \
    --set-env-vars="NODE_ENV=production,APP_URL=${APP_URL},FIREBASE_PROJECT_ID=${PROJECT_ID},TRUST_PROXY_HOPS=${TRUST_PROXY_HOPS},STRIPE_PRICE_PRO=${STRIPE_PRICE_PRO},STRIPE_PRICE_TEAM=${STRIPE_PRICE_TEAM}" \
    --set-secrets="STRIPE_SECRET_KEY=${SECRET_STRIPE_KEY}:latest,STRIPE_WEBHOOK_SECRET=${SECRET_STRIPE_WEBHOOK}:latest" \
    --quiet

  log "Deploying Firestore rules, indexes and Hosting"
  run firebase deploy --project="$PROJECT_ID" --non-interactive \
    --only=firestore:rules,firestore:indexes,hosting

  log "Deployed"
  cat <<EOF
  Web:     $APP_URL
  Health:  $APP_URL/api/health

Follow-ups (first deploy, or when something changed):
  - Smoke test:  curl -fsS $APP_URL/api/health
  - APP_URL is $APP_URL. With a custom domain, re-run with APP_URL=https://<domain>,
    add the domain under Authentication → Settings → Authorized domains, and
    point the Stripe webhook at the new URL.
  - Secrets are referenced as ":latest" and resolved when an instance starts.
    After rotating one, re-run deploy so all instances restart with it.
EOF
  print_webhook_steps
}

log "saas-starter: $COMMAND"
print_config
case "$COMMAND" in
  setup) cmd_setup ;;
  deploy) cmd_deploy ;;
  webhook) print_webhook_steps ;;
esac
