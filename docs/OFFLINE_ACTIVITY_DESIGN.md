# Offline activity snapshots

This is a proposed design. The current Activity and Home screens still require
the server for payment history.

## Store a snapshot with its session

Store the last successful activity response inside the existing secure session
record, alongside its user and token. This keeps the snapshot scoped to the API
configuration and account. Deleting the session on logout also deletes its
snapshot. A new session must not inherit another session's cached activity,
even when both sessions belong to the same user.

Persist only the payment fields needed by the existing receipt and activity
views. Keep amounts as minor-unit strings with their asset and scale. Do not
store payment codes, device secrets, provider tokens, or authorization URLs.
Treat payment history and names as sensitive data. Platform secure-storage
properties vary and do not by themselves establish biometric protection.

## Coordinate reads, writes, and logout

- Serialize session and snapshot changes through one storage owner. A snapshot
  write must verify the same session and user immediately before writing.
- Invalidate in-flight work when logout or an account change starts. A response
  from the old session must not repopulate the new session's cache.
- Prevent an older concurrent response from replacing a newer snapshot. A fresh
  server response remains usable even when the cache write fails.
- On an activity request rejected with `401` or `403`, block cached activity and
  clear its persisted snapshot. A failed deletion must be surfaced and must not
  make the snapshot available again in the current process.
- Preserve existing session data when refreshing the same session. Discard the
  snapshot when creating or restoring a different session.

## Display cached activity honestly

Use a snapshot only when a request fails because the device is disconnected or
the connection times out without an HTTP response. Never treat a `401`, `403`,
server error, malformed response, or cancelled request as offline success.
Label the list and any opened receipt as offline data and show the last
successful sync time. A cached permission is not a current wallet balance or
authority to spend.

## Release checks

Verify login, logout, a second account on the same device, same-account
re-login, concurrent refreshes, storage failures, and a `401` or `403` followed
by an offline restart. Check both Home and Activity, including receipt details.
Do not claim cross-restart cleanup if the platform refuses both the snapshot
update and session deletion; surface that failure and keep access blocked in
the running app.
