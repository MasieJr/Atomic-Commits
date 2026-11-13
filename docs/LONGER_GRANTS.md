# Longer outgoing payment grants

## Current behavior

The server-side approval flow gives the payer ten minutes to complete the
interaction. This is a local deadline for the callback, not the lifetime of a
grant or access token. For new approvals, the application records a local grant
validity of 720 hours from insertion. This is a maximum enforced by the app, not
a provider-guaranteed term. Existing grants retain their stored validity.

New device enrollments expire at the earlier of 30 days after enrollment or
the local grant end. Existing devices retain their stored expiry. The provider
may end authority before either local deadline.

The outgoing request asks for a non-recurring cumulative debit limit, not an
interval. The cap does not reset monthly, and the grant does not auto-renew. The
provider adapter validates the returned debit cap and access scope, but does not
receive or validate an explicit grant expiry. It requires `access_token.expires_in`
and records a conservative token expiry from the time the continuation request
started. That token expiry is not a grant expiry. A provider may revoke or deny
authority before the application's local 720-hour deadline.

Redemption attempts token rotation when the token is near expiry. A refused
rotation requires reauthorization; an uncertain rotation blocks the grant.
Rotation replaces a token, not payer consent, and does not prove the grant lasts
for a month. Rotation is attempted on use, not scheduled in the background.

## Provider terms and limits

The current non-interval request and `FinishedGrant` result do not provide a
verified provider-granted grant end time. The local cutoff does not establish
how long the provider authorizes the grant. The interaction table restricts
`valid_hours` to 1 through 720 hours. No migration or live provider test was
performed for this change.

Open Payments supports interval grants, but that does not establish support or
returned terms for this particular Test Wallet. The official
[future payments guide](https://openpayments.dev/guides/outgoing-grant-future-payments/)
describes a three-month interval with a monthly resetting debit cap. The
[recurring remittance guide](https://openpayments.dev/guides/recurring-remittance-fixed-debit/)
shows an example continuation response containing the granted interval. The
current validator rejects interval fields, and local accounting tracks one
cumulative cap; it does not implement monthly resets. Do not present that cap as
a monthly allowance or infer accepted terms from the request alone.

The [token rotation documentation](https://openpayments.dev/sdk/token-rotate/)
says tokens have a ten-minute default lifespan and a rotated token has the same
rights and properties. The actual provider-returned expiry must be used; neither
the default token lifespan nor the interaction deadline is a grant end date.

## Further provider verification

Confirm the target provider's supported request and returned grant-validity
semantics, including shortened or missing terms, revocation, and rotation after
inactivity. If the provider returns verifiable grant expiry terms, validate them
and bound local validity to them. If using recurring intervals, design consent, period
accounting, reservations and reconciliation for provider-granted intervals
before promising resets. Coordinate any schema, API and client changes separately.
Use a controlled provider integration test only when separately authorized.
