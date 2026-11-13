# Set up signup email verification

Signup verification is disabled by default. While it is disabled, the existing
name, email, and password signup remains available. Enable verification only
after the provider and updated client are ready.

## Configure Supabase

1. Enable email authentication for the project.
2. Edit the **Magic Link** email template to include the numeric `{{ .Token }}`
   value. The app asks users to enter that code rather than follow a link.
3. Configure the OTP expiry and rate limits for your deployment. Supabase's
   default OTP expiry is one hour and the default resend interval is 60 seconds.
4. Configure a production SMTP service and verify the sender domain. Supabase's
   default SMTP service is restricted to project team addresses and is not
   suitable for general signup.

## Configure the backend

Set these values in the protected server environment:

```text
EMAIL_VERIFICATION_REQUIRED=1
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<publishable-key>
```

The backend also accepts the legacy `SUPABASE_ANON_KEY` in place of the
publishable key. Never put a service-role key in the app or the repository.
`SUPABASE_URL` must be an HTTPS origin without credentials or a path.

When verification is required but configuration is missing or malformed,
signup fails closed. Existing password login remains independent. The backend
accepts a successful verification only when Supabase returns a session, a user
ID, a confirmed email, and the same normalized email address.

## Rollout and recovery

Deploy the updated client and backend with `EMAIL_VERIFICATION_REQUIRED=0`.
Verify delivery and the Supabase response contract using a disposable account.
Then enable the flag. Once enabled, older clients that do not send an email
code cannot register and must update. The backend never accepts a code as proof
while verification is disabled; if the setting changes during signup, restart
the flow.

The code is single-use. If Supabase accepts it but account creation later fails,
request a new code. If the app loses the registration response, try signing in
before requesting another code because account creation may have completed.
Do not log codes, provider responses, or tokens.

## References

- [Supabase email OTP](https://supabase.com/docs/guides/auth/auth-email-passwordless)
- [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates)
- [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
