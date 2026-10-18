# Refresh and session termination

[README](../../README.md) | [Architecture](../../ARCHITECTURE.md)

Refresh uses /auth/oauth/token with the refresh_token grant and client authentication; it never uses Rita ID's SSO /auth/refresh.
Manual refresh requires matching CSRF and, when supplied, a matching Origin. No refresh token produces 409.

For an established session, replacement credentials are stored before JWT/userinfo verification. Temporary verification failures return 503,
retain them and allow verification to be retried only after a five-second cooldown, without replaying the old refresh token.
JWKS HTTP errors, timeout and invalid JWKS JSON/schema are temporary. Wrong subject, purpose, audience or
signature ends authentication. 403 preserves the session. Expired replacement during pending verification ends the session without a new rotation.

Login callback does not retain new tokens after verification failure, including a JWKS outage: it attempts to revoke any new refresh token,
creates no authenticated session and redirects to /?auth=authentication_failed, preserving an existing login if still valid.
See the [login flow](01-login-and-guard.md) for callback cancellation and best-effort cleanup.

An explicit provider 503 temporarily_unavailable is retryable; ambiguous refresh timeout, lost response, malformed response or missing replacement
ends the local session rather than replaying the old token. Configuration errors return 502 without redirect loops. Invalid grant returns 401.

Logout marks closing/cancels callbacks before awaiting anything, flushes cookie deletion, waits for an active refresh and attempts to revoke its latest refresh token.
Local data is removed even if revoke fails; JSON distinguishes revokeConfirmed=false. Missing/stale cookies make logout idempotent; valid entries
still require CSRF. Late private responses cannot restore frontend state. Login changes and logout are signaled to other tabs without credentials.

Neither app logout nor OAuth revoke logs out Rita ID SSO. Issued access JWTs may remain valid until expiry. Restart loses RAM and cannot guarantee revoke.
