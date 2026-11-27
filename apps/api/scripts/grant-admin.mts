/**
 * Grant or revoke the global `admin` role (Firebase custom claim).
 *
 *   npx nx grant-admin api -- someone@example.com
 *   npx nx grant-admin api -- someone@example.com --revoke
 *   npx nx grant-admin api -- someone@example.com --force   # unverified email
 *
 * Uses FIREBASE_PROJECT_ID and Application Default Credentials
 * (`gcloud auth application-default login`), or the emulators when
 * FIREBASE_AUTH_EMULATOR_HOST / FIRESTORE_EMULATOR_HOST are set.
 * Runs on Node's built-in type stripping: keep the syntax erasable.
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const NOT_FOUND = 5;

const args = process.argv.slice(2);
const revoke = args.includes('--revoke');
const force = args.includes('--force');
const email = args.find((arg) => !arg.startsWith('--'))?.trim();
const projectId = process.env['FIREBASE_PROJECT_ID'];

if (!email || !projectId) {
  console.error(
    'Usage: npx nx grant-admin api -- <email> [--revoke] [--force]\n' +
      '(FIREBASE_PROJECT_ID must be set, e.g. in .env)',
  );
  process.exit(1);
}

initializeApp({ projectId });
const auth = getAuth();
const db = getFirestore();

let user;
try {
  user = await auth.getUserByEmail(email);
} catch (err) {
  if ((err as { code?: unknown }).code === 'auth/user-not-found') {
    console.error(`No account for ${email}. They need to sign in once first.`);
    process.exit(1);
  }
  throw err;
}
const providers = user.providerData.map((p) => p.providerId).join(', ');
console.log(
  `Account ${user.uid} (providers: ${providers || 'none'}, ` +
    `email verified: ${user.emailVerified})`,
);

// Anyone can sign up with an address they don't own; only a verified email
// proves the account belongs to the person you mean to promote.
if (!revoke && !user.emailVerified && !force) {
  console.error(
    'Refusing to grant admin: this email is not verified. Confirm the account ' +
      'above is the right one, then re-run with --force.',
  );
  process.exit(1);
}

const role = revoke ? 'user' : 'admin';

// Audit first (as pending), so a privilege change is never left unrecorded,
// then mark it applied or failed.
const audit = await db.collection('auditLog').add({
  actorUid: 'cli',
  action: revoke ? 'role.revoke' : 'role.grant',
  targetUid: user.uid,
  at: FieldValue.serverTimestamp(),
  status: 'pending',
  meta: { role: 'admin', forced: force && !user.emailVerified },
});

try {
  const claims: Record<string, unknown> = { ...(user.customClaims ?? {}) };
  if (revoke) delete claims['role'];
  else claims['role'] = 'admin';
  await auth.setCustomUserClaims(user.uid, claims);

  if (revoke) {
    // Existing ID tokens still carry the admin claim for up to an hour;
    // revoking refresh tokens makes the api's revocation check reject them now.
    await auth.revokeRefreshTokens(user.uid);
  }
} catch (err) {
  await audit.update({ status: 'failed', error: (err as Error).message });
  throw err;
}
await audit.update({ status: 'applied' });

try {
  // Keep the users/{uid} mirror in sync, if the profile exists yet (otherwise
  // GET /api/auth/me creates it from the claim). roleChangedAt stops a token
  // issued before this change from reverting the mirror.
  await db
    .collection('users')
    .doc(user.uid)
    .update({ role, roleChangedAt: FieldValue.serverTimestamp() });
} catch (err) {
  if ((err as { code?: unknown }).code !== NOT_FOUND) throw err;
}

console.log(
  revoke
    ? `${user.uid}: role is now "user"; existing sessions were revoked.`
    : `${user.uid}: role is now "admin". It applies once the user's ID token ` +
        'refreshes (sign out and in, or getIdToken(true)).',
);
