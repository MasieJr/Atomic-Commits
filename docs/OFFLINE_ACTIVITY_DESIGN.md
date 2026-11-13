# Offline activity snapshots

The Activity and Home screens can display the last successful payment-history
response while the same session is offline. The implementation is in the PR;
browser restart and device behavior still need verification before release.

## Store a snapshot with its session

The app stores the last successful activity response inside the secure session
record, alongside its user and token. This keeps the snapshot scoped to the API
configuration and account. Deleting the session on logout also deletes its
snapshot. A new session must not inherit another session's cached activity,
even when both sessions belong to the same user.

The snapshot contains only the payment fields needed by the receipt and activity
views. Keep amounts as minor-unit strings with their asset and scale. Do not
store payment codes, device secrets, provider tokens, or authorization URLs.
Treat payment history and names as sensitive data. Platform secure-storage
properties vary and do not by themselves establish biometric protection.

## Reads, writes, and logout

- One storage owner serializes session and snapshot changes. A snapshot write
  checks the session and user before writing.
- Logout and account changes invalidate in-flight work. Responses from an old
  session cannot repopulate the new session's cache.
- Home and Activity share one controller and one in-flight request. A fresh
  response remains usable if the cache write fails.
- A `401` or `403` on the activity request blocks cached activity and clears its
  persisted snapshot. If that write fails, the UI reports the failure and keeps
  the snapshot blocked in the current process.
- A refresh of the same session retains its snapshot. A different session starts
  without one.

## Display cached activity honestly

The app uses a snapshot only when a request fails because the device is disconnected or
the connection times out without an HTTP response. Never treat a `401`, `403`,
server error, malformed response, or cancelled request as offline success.
The list and any opened receipt label offline data and show the last
successful sync time. A cached permission is not a current wallet balance or
authority to spend.

## Release checks

Verify login, logout, a second account on the same device, same-account
re-login, concurrent refreshes, storage failures, and a `401` or `403` followed
by an offline restart. Check both Home and Activity, including receipt details.
Do not claim cross-restart cleanup if the platform refuses both the snapshot
update and session deletion; surface that failure and keep access blocked in
the running app.
