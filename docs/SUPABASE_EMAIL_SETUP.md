# Supabase email ownership verification setup

The backend sends a one-time email code through Supabase Auth and verifies it
before completing email signup. Configure Supabase and the backend before
releasing the signup change.

## Backend configuration

Set these in the **backend's server environment** (not the Flutter app):

```text
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<publishable-key>
```

Use the project's publishable key; `SUPABASE_ANON_KEY` is accepted for older
projects/configurations. `SUPABASE_URL` must be the HTTPS project origin. These
are backend runtime settings; do not put credentials in Flutter or commit real
`.env` values. Never use or expose a Supabase `service_role`/secret key for this
flow. The backend uses the Auth OTP and verify endpoints with the publishable
(or legacy anon) key.

## Auth and email template

In the Supabase Dashboard, open **Authentication → Providers → Email** and make
sure email signup is enabled. Under **Authentication → Email Templates**, edit
the **Magic Link** template to send a numeric code, for example:

```html
<p>Your Atomic Commits verification code is:</p>
<h2>{{ .Token }}</h2>
```

The backend calls the email OTP endpoint (`create_user: true`) for new signups,
then verifies with `type: "email"`. Supabase uses the **Magic Link** template
for this email OTP flow. Include `{{ .Token }}` rather than a link-only
`{{ .ConfirmationURL }}`. Ensure the message identifies the code and its expiry.

In **Authentication → Rate Limits**, review the email-send and OTP verification
limits for your expected signup traffic. Supabase OTPs expire after 1 hour by
default; configure **Email OTP Expiration** under **Authentication → Settings**
to a suitably short lifetime for verification codes. Keep send and verification
rate limits enabled and restrictive enough to deter abuse; the backend also
returns rate-limit failures to callers.

## Deliverability and release

Supabase's default SMTP service is for testing: it only sends to addresses
associated with project team members and is subject to a low rate limit. It is
not suitable for general users. Before enabling public signup, configure a
production SMTP provider under **Project Settings → Authentication → SMTP
Settings** (menu wording may vary), verify the sender/domain and SPF/DKIM records
with that provider, and test delivery to recipient domains you expect to support.

Coordinate rollout: deploy the backend with both Supabase settings present and
the Supabase email/template/SMTP configuration ready before exposing the
updated signup UI. The backend must fail closed for email signup/verification
when Supabase is unavailable or unconfigured; do not bypass verification or
fall back to creating an unverified account. Existing local password logins
remain supported and do not require Supabase email verification.

`GET /api/auth/email-verification/status` always returns `required: true`.
Its `available` flag checks backend configuration and access to the local user
table, not Supabase health or email delivery. A later request can still fail;
clients must handle those errors and must not skip verification. If refresh-token
storage fails during registration or login, the response contains an access
token but no refresh token; the user must sign in again when it expires.

The backend accepts verification only when Supabase returns a successful session
with a nonempty access token and user ID, a confirmed email, and an email matching
the requested normalized address. Check this response contract and one-time OTP
behavior with a disposable project before rollout. A consumed code must be
requested again if local account creation subsequently fails; Supabase users are
separate from local accounts. Do not log OTPs, provider responses, or tokens.

## References

- [Supabase passwordless email logins / OTP](https://supabase.com/docs/guides/auth/auth-email-passwordless)
- [Supabase Auth email templates](https://supabase.com/docs/guides/auth/auth-email-templates)
- [Supabase Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits)
- [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Supabase API keys](https://supabase.com/docs/guides/api/api-keys)
