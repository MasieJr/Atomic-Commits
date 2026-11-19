# Set up Google sign-in

Google authentication uses the existing local JWT service. It does not use Supabase Auth sessions or change payments.

## Configure the backend-hosted OAuth client

1. Create a Google Cloud project for the deployment tier. Configure branding, consent, and test users as needed.
2. Create a **Web application** OAuth client for the backend-hosted authorization flow. Do not embed its secret in Flutter or browser code.
3. Set the authorized redirect URI to `https://YOUR_API_HOST/api/auth/google/callback`. It must match exactly.
4. Provide `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `PUBLIC_BASE_URL` through the backend's secret/configuration system. `PUBLIC_BASE_URL` must be an HTTPS origin without a path, query, fragment, or credentials.
5. Retain the existing `DATABASE_URL`, `JWT_SECRET`, and versioned `DATA_ENCRYPTION_KEY` configuration. Keep the encryption key separate from the JWT secret.
6. Apply `backend/sql/007_google_oauth.sql` with a reviewed, explicitly authorized migration procedure. The normal migrator applies every pending numbered file, including the unfinished `006_multiple_wallets.sql` when present. Do not use it until every pending migration is safe to apply. Record the applied `007_google_oauth.sql` version in `app_private.schema_migrations` in the same transaction as the schema changes.
7. Verify the redirect, table access, and provider flow. Set `GOOGLE_AUTH_ENABLED=1` only when they are ready. The default is disabled.

The backend must access all four new tables through its private Postgres connection, with table-owner privileges or explicitly configured backend-only permissions and RLS policies. RLS is enabled without public policies. Do not expose `app_private` through the Supabase Data API or grant client roles access.

Use the revised `007` migration only if that version has not been applied. If an earlier version was applied, arrange a separate forward migration before enabling linking. Changing this file alone does not update an existing database.

Only the backend is the Google OAuth client in this flow. If you add a native Google SDK later, register the appropriate platform clients and design separate audience validation. Do not reuse the web client secret as a native-app credential.

## Availability and cleanup

The router uses the existing database pool, token service, and encryption instance independently of payments. It is mounted before the blanket `/api/auth` limiter, with separate limits for start, callback, consume, link, and cancel. Password and email routes retain the existing limiter.

`GET /api/auth/google/status` returns `{ "enabled": true }` or `{ "enabled": false }` with `Cache-Control: no-store`. The backend requires the explicit enable flag, valid configuration, a recorded `007_google_oauth.sql` migration, and the four expected tables. It caches this database check for five seconds. This does not verify Google connectivity or the correctness of the provider credentials. If any required condition is absent or the database check fails, Google endpoints return `503` and password login remains independent. Disable the Google button when unavailable. Do not fall back to unverified tokens or email-based linking.

The server schedules a separate non-overlapping `pruneAttempts()` pass every minute and stops its timer on shutdown. Each call clears at most 500 stale attempts, deletes at most 500 attempts expired for more than one day, and removes at most 500 expired windows from each of the IP and account link-limit tables. Multiple instances may run cleanup because rows use `SKIP LOCKED`. Monitor backlog and increase scheduling frequency if needed. Deadline and rate-limit checks do not depend on this timer.

The link service has shared Postgres IP, account, and per-attempt limits. Consume also has a shared per-attempt budget. The router's aggregate IP limits remain process-local. For multiple backend instances, configure shared or trusted-proxy aggregate limits before launch. Configure proxy trust narrowly because IP limits use Express's `req.ip`, not a body parameter. Do not trust arbitrary client-forwarded IP headers.

Consume permits 60 requests per minute per authenticated attempt and 600 per minute per IP bucket per backend process. Normal two-second polling uses 30 requests per minute, so four users behind one NAT use 120 requests, not one shared 90-request allowance. The attempt budget is checked only after the poll secret matches; wrong secrets cannot spend it. All router IP limits and the shared link IP limit normalize IPv4-mapped addresses and group IPv6 addresses into /56 buckets.

Start allows 300 requests per 15 minutes per IP bucket per process instead of a per-person quota of ten. This is still an aggregate abuse ceiling, not a guarantee for arbitrarily large shared networks; monitor it and configure a shared edge limit appropriate to expected NAT traffic. Link password checks retain their stricter limits.

## Launch sign-in in the system browser

1. Call `POST /api/auth/google/attempts` from the initiating app over HTTPS. Send an empty JSON object. Never start from a copied authorization link.
2. Keep the returned `attemptId` and `pollSecret` in that app instance. Use memory, or OS-protected temporary storage if resuming after an app restart is required. Clear both at completion, cancellation, failure, or expiry.
3. Open `authorizationUrl` in the supported external system browser. In Flutter, use the system-browser launch option such as `LaunchMode.externalApplication`. **Do not use an embedded WebView, an in-app web renderer, or a spoofed user agent.** If external launch fails, cancel the attempt and show a retry action.
4. Poll `POST /api/auth/google/attempts/{attemptId}/consume` with JSON `{ "pollSecret": "..." }` no faster than the returned `pollIntervalMs` (2,000 ms). Use one in-flight poll per attempt. Pause while the app is suspended and poll when it resumes.
5. On `status: "complete"`, persist the returned local `token` using the existing auth repository and display the returned `user`. Do not accept tokens, account IDs, or email addresses from the browser callback.
6. On `status: "link_required"`, pause polling and follow the password-proof flow below. Do not start another Google attempt or ask for the user's Google password.
7. On app-side cancellation, stop polling and call `POST /api/auth/google/attempts/{attemptId}/cancel` with the same JSON proof. Do not cancel merely because opening the external browser suspends the app.

For browser frontends, use a user-initiated top-level tab/window, not an iframe. Allow only the application's exact HTTPS origin through the existing CORS configuration. Keep the poll secret out of browser history and analytics. The flow needs no `postMessage`, custom URI scheme, or app-link token delivery.

The start response has `attemptId`, `pollSecret`, `authorizationUrl`, `expiresAt`, `expiresInMs`, and `pollIntervalMs`. The link-required response also has `expiresInMs`. The app uses this server-calculated remaining lifetime with a monotonic clock, conservatively deducting request time, rather than comparing the server expiry to the device wall clock. Deploy this backend before the updated app; an older backend without the field fails closed. A pending consume response is HTTP `202` with `status: "pending"`, `pollIntervalMs`, and a `Retry-After` header. Other valid-attempt results are HTTP `200`:

- `complete`: `user` and the existing local JWT `token`. Returned once.
- `link_required`: `attemptsRemaining` and the shortened `expiresAt`. Request fresh local password proof and explicit consent to connect Google.
- `cancelled`: discard the attempt. A later callback cannot revive it.
- `expired`: start a new attempt if the user requests it.
- `consumed`: stop polling. If the successful response was lost, start a new attempt. Do not offer replay recovery.
- `failed` with `code: "link_attempts_exhausted"`: stop requesting the password. Offer normal password sign-in or an account-recovery flow if one is available.
- `failed` with `code: "link_conflict"`: no account was reassigned. Offer existing sign-in and an account-settings/support path, not another automatic link attempt.
- `failed` with `code: "google_verification_failed"` or `"processing_timeout"`: show a generic failure and a user-triggered retry.

Malformed proof is HTTP `400`. Unknown attempts and incorrect well-formed poll secrets have the same HTTP `404` response. An exhausted consume-attempt budget returns HTTP `429`, `{ "status": "rate_limited", "retryAfterSeconds": 60 }`; the aggregate IP limiter returns `GOOGLE_RATE_LIMITED`. Respect `Retry-After` in either case. Cancellation has a separate endpoint and budget, so a polling limit does not prevent cancellation. A storage outage does not authorize a login. On cancellation racing with a successful consume, discard any late token on the client if the user cancelled. Cancellation does not revoke a JWT already delivered.

## Preserve the security boundaries

- Keep authorization-code flow, `S256` PKCE, state, and nonce enabled. Each value and the independent poll secret has 256 bits of randomness.
- Keep the verifier encrypted through `DataEncryption`, with the attempt ID and purpose bound as authenticated additional data. The database stores only SHA-256 hashes of state, nonce, and poll secret.
- Keep Google verification on the backend. The verifier accepts only RS256 signatures from Google's fixed HTTPS JWKS endpoint. It checks issuer, the exact single web audience, `azp` when present, expiry, issuance time, optional `nbf`, nonce, subject, and boolean `email_verified: true`.
- Do not accept a raw ID token from a mobile client in place of the code flow. Do not use Google's `tokeninfo` debug endpoint as production validation.
- Keep Google authorization, token, and JWKS endpoints fixed. Provider requests reject redirects, time out after ten seconds, and cap response size. JWKS refresh is cached, bounded, and coalesced. Keys are not accepted from JWT headers.
- Keep the callback free of local tokens and user details. It redirects only to the fixed same-origin `/api/auth/google/complete` page. That page contains no scripts, external resources, or app deep links.
- Redact callback query strings, request and response bodies, passwords, authorization URLs, client secrets, and bearer tokens from application, proxy, tracing, crash-reporting, and analytics logs. The response headers alone cannot prevent infrastructure logging.
- The Azure Nginx example disables access logging for the exact Google callback location. Apply equivalent redaction to every proxy and observability layer, including error logs.
- Keep the frontend's browser-launch path under review. The backend cannot prove that a URL was opened in the system browser. Never ask users to approve sign-in links sent by another person.

Attempts expire after ten minutes. A password-proof prompt lasts at most five minutes after Google verification. A ready handoff lasts at most two minutes. Neither transition extends the previous deadline. A claimed callback or password check gets 45 seconds to finish. A process crash after claiming does not replay code exchange or password proof. The client observes failure/expiry and starts a new attempt.

The callback claim is atomic. Account creation, subject mapping, and readiness share a transaction. Cancellation and consumption lock the attempt row. Only one consume can commit a session handoff, and the response is not returned before commit. No Google tokens, local JWTs, or raw poll secrets are stored in these tables. A lost successful consume response therefore requires a new login rather than replaying the token.

## Connect an existing account with password proof

Treat the verified Google `sub` as the credential identity. The database enforces one mapping per Google subject and per local user. Repeated sign-in for that subject returns the same local user even if Google's email or display name changes. It does not silently change local profile data.

For a new subject, the callback inserts a normalized local email under the existing unique constraint. If that email already belongs to a local user, the callback records `link_required` without creating a mapping or issuing a session. Only this verified callback selects and stores the Google subject and local user ID. Neither value comes from a link request. Concurrent password signup and Google signup cannot create duplicate email rows.

When consume returns `link_required`, present an explicit action such as **Connect Google to my existing Atomic Commits account**. Explain that this adds Google as a future sign-in method. Label the password field **Atomic Commits password**, not Google password. Keep a cancel action available.

On confirmation, send this request over HTTPS:

```http
POST /api/auth/google/attempts/{attemptId}/link
Content-Type: application/json

{
  "pollSecret": "the same secret returned when this attempt started",
  "password": "the freshly entered local account password",
  "confirmLink": true
}
```

Do not send an email, user ID, Google subject, or client IP as a selector or proof. The router ignores such fields. A bearer token is not a substitute for fresh password proof. Do not save the password in temporary attempt storage, logs, or analytics. Clear the password field after the request.

Handle the link endpoint's responses as follows:

- HTTP `200`, `{ "status": "ready" }`: call consume with the same attempt and poll secret. The link response itself never contains a token. Repeating link after readiness does not extend the deadline or mint a session.
- HTTP `401`, `{ "status": "invalid_password", "attemptsRemaining": 4 }`: keep the same prompt and show a generic incorrect-password message. Permit another user-triggered submission only after at least two seconds. Missing, malformed, and unusable credentials have the same failure response.
- HTTP `429`, `{ "status": "rate_limited", "retryAfterSeconds": 2 }`: honor `Retry-After`. Both shared IP and account budgets instead return the same conservative 900-second retry delay, without identifying the exhausted budget or disclosing account details. The router may return its generic `GOOGLE_RATE_LIMITED` body. Never automatically resubmit a password. The attempt may expire before the budget reopens; offer ordinary password sign-in rather than restarting Google attempts to evade the limit.
- HTTP `409`, `{ "status": "failed", "code": "link_attempts_exhausted" }`: the fifth failed check ended the attempt. Do not retry it.
- HTTP `409`, `{ "status": "failed", "code": "link_conflict" }`: the subject or local account is already mapped differently. Nothing is replaced or merged.
- HTTP `410`, `status` of `cancelled`, `expired`, or `consumed`: discard the attempt. A deadline crossed during finalization can instead return error code `GOOGLE_ATTEMPT_EXPIRED` with HTTP `410`.
- HTTP `400` with `GOOGLE_LINK_CONFIRMATION_REQUIRED`: explicit confirmation is missing. HTTP `409` with `GOOGLE_LINK_NOT_READY` means this attempt has not reached password proof. Neither response authorizes linking.

Malformed attempt proof remains HTTP `400`; unknown attempts and wrong poll secrets remain HTTP `404`. If the link response is lost, poll consume rather than resending the password automatically. A committed link is ready for one-time retrieval; an uncommitted operation remains pending until completion or timeout.

The service permits at most five password checks per attempt, one in flight at a time, at least two seconds apart. It commits each reservation before bcrypt, so a crash or later transaction failure cannot restore that budget. Missing or unusable credentials still run a valid bcrypt dummy comparison at the current registration cost of 12. Dummy results can never authorize linking. Passwords must satisfy the existing local login bounds of at least eight characters and at most 72 UTF-8 bytes.

`google_oauth_link_account_limits` additionally permits at most ten password-check reservations per local account in a fixed 15-minute window. An atomic upsert uses only the callback-selected local user ID, after validating the attempt proof and checking its state/cooldown. Neither a new attempt, a new IP, another Google subject, cancellation, nor a backend restart resets this budget. Its reservation commits with the per-attempt reservation before reading a password result. Successful, failed, and dummy comparisons all count; expiry during reservation may consume budget without a comparison. Rejected requests do not extend the window, and the first reservation after expiry resets it without requiring cleanup.

This account budget belongs only to Google password linking. It does not lock or change ordinary password login, and no account-limit lookup by client-supplied email or user ID is exposed. A caller must possess a verified link-required attempt and its poll secret before it can spend the account budget or observe its generic refusal. Someone who controls that Google identity can still temporarily exhaust Google linking for the selected local account; the short window and the unchanged password sign-in path limit that denial of service. Fixed windows allow bursts around a window boundary and are not a substitute for abuse monitoring or account recovery.

The existing flow itself is not account-existence-oblivious: after Google verifies an email, `link_required` reveals to the holder of that attempt that the email collided with a local account. The account budget adds no lookup by arbitrary email, but its generic rate-limit response does not remove that pre-existing disclosure. Hiding the collision requires a different linking UX and protocol.

Every link request reaching the service is charged against a shared ten-request, 15-minute IP window, even if its attempt proof or confirmation is invalid. IPv4-mapped addresses are normalized; IPv6 addresses share a /56 network bucket. `google_oauth_link_limits` stores a hash of that network key, not the raw address. This is a rate-limit identifier, not a claim that IP hashes are anonymous. A missing trustworthy IP or unavailable budget storage fails closed.

Bcrypt runs outside database locks. Finalization locks the attempt, the Google subject, and the selected local user. It checks that the current password hash still equals the hash just verified. Password changes, cancellation, expiry, and check timeouts therefore cannot reuse stale proof. Mapping insertion and readiness commit together under unique subject and user constraints. An existing matching mapping is safe to reuse; a different mapping is never overwritten.

New Google-only users retain the existing non-null `password_hash` schema. The service hashes a fresh random 256-bit password with bcrypt and discards the password. It is not a default password and is never sent to the client. Do not add a password-setting or account-linking shortcut based only on a matching Google email.

If the user cannot supply the local password, stop linking. Password recovery and unlinking are not implemented here and require separate ownership-verified flows. Do not substitute Google's verified email for password proof. Google sign-in does not prove authority over a payment wallet, TOTP device, or Supabase Auth account.

Cancellation that commits before link finalization prevents the mapping and session handoff. If linking commits first, cancellation still prevents an unconsumed handoff but does not unlink the newly connected credential. Likewise, a callback may create a new account before retrieval is abandoned. Explain the permanent link action before submission. No wallet, payment, device, or balance is created here.

## Run credential-free local checks

From `backend`, this focused TypeScript check emits no files and does not load environment files:

```powershell
.\node_modules\.bin\tsc.cmd --noEmit --strict --esModuleInterop --skipLibCheck --target ES2022 --module Node16 --moduleResolution Node16 --types node src/services/google-oauth.ts src/routes/google-oauth.ts
```

The following small probe exercises attempt creation and secret separation without a database or network. Its storage adapter captures parameters in memory instead of executing SQL. It does not verify Postgres locking, migration syntax, or live Google behavior.

```powershell
node --import tsx -e "
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { createGoogleOAuthService } = require('./src/services/google-oauth.ts');
const { createDataEncryption } = require('./src/services/data-encryption.ts');
const { createAccessTokenService } = require('./src/services/tokens.ts');
let stored;
const encryption = createDataEncryption(new Map([[1, randomBytes(32)]]), 1);
const pool = {
	query: async (_sql, values) => {
		stored = values;
		return { rows: [{ expires_at: new Date(Date.now() + 600000), expires_in_ms: 600000 }] };
	},
	connect: async () => { throw new Error('No database in this probe'); },
};
global.fetch = async () => { throw new Error('No network in this probe'); };
const service = createGoogleOAuthService({
	pool, encryption,
	tokens: createAccessTokenService('offline-only-key-not-a-production-secret'),
	clientId: 'offline.apps.googleusercontent.com',
	clientSecret: 'offline-placeholder',
	publicBaseUrl: 'https://api.example.test',
});
(async () => {
	const started = await service.start();
	const url = new URL(started.authorizationUrl);
	const verifier = encryption.decrypt(
		{ ciphertext: stored[4], keyVersion: stored[5] },
		'google-oauth:' + started.attemptId + ':pkce',
	);
	const digest = value => createHash('sha256').update(value).digest();
	assert.equal(url.searchParams.get('response_type'), 'code');
	assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
	assert.equal(url.searchParams.get('code_challenge'), digest(verifier).toString('base64url'));
	assert.equal(url.toString().includes(started.pollSecret), false);
	assert.deepEqual(stored[1], digest(url.searchParams.get('state')));
	assert.deepEqual(stored[2], digest(started.pollSecret));
	assert.deepEqual(stored[3], digest(url.searchParams.get('nonce')));
	await assert.rejects(service.consume({ attemptId: started.attemptId, pollSecret: 'short' }));
	console.log('PASS: offline attempt/PKCE/secret-separation probe');
})().catch(() => { console.error('Offline probe failed'); process.exitCode = 1; });
"
```

## Verify before enabling production

Use isolated credentials and a disposable database only when authorized. Cover successful sign-in, wrong issuer/audience/signature/nonce, expired and unverified tokens, duplicate callbacks, wrong poll secrets, concurrent consumes, local-email collisions, concurrent account creation, cancellation, process restart, and cleanup. For linking, cover fresh password success, dummy credential handling, stale-password races, both mapping conflicts, concurrent link/cancel/consume, and durable per-attempt/IP/account budgets across processes. Check that rotating attempts/IPs cannot exceed the account budget, another account remains independent, expired windows reset, and a failed finalization does not refund a comparison. For polling, exercise four clients behind one NAT at two-second intervals, the 60-request attempt limit, the 600-request aggregate limit, IPv4-mapped/IPv6 subnet keys, and wrong-secret requests that cannot consume another attempt's budget. Verify external-browser launch on each supported mobile platform.

Do not infer OAuth readiness from a TypeScript check. Credential registration, the authorized redirect URI, consent settings, HTTPS reachability, proxy redaction, and actual browser behavior need separate verification. No live OAuth, email, database migration, or payment operation is performed by adding these files.

Authoritative references:

- [Google OpenID Connect server flow and ID-token validation](https://developers.google.com/identity/openid-connect/openid-connect)
- [Google discovery metadata](https://accounts.google.com/.well-known/openid-configuration)
- [Google OAuth policies, including secure browsers](https://developers.google.com/identity/protocols/oauth2/policies#secure-browsers)
