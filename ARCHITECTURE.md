# OAuth SPA architecture

[README](README.md) | [Test matrix](docs/TEST-MATRIX.md)

## Components

- Express serves static HTML/CSS/JavaScript, local Axios and JSON endpoints on one origin.
- OAuthSessions owns one Map of anonymous/authenticated entries. No secondary Express session store exists.
- Cookie middleware reads exactly one `rita_example.key`, checks its syntax, hashes it with SHA-256 and looks up the entry.
- RitaAuthStrategy binds and consumes login attempts; RitaAuthGuard resolves identity before private handlers.
- OAuthClient performs server-to-server token/userinfo/revoke requests and RS256/JWKS validation.
- The SPA bootstraps through /api/session, then loads /api/me; profile is not embedded in HTML.

## Entry and credential ownership

Cookie keys use 32 cryptographically random bytes; raw keys are only sent in HttpOnly cookies.
The store indexes by hash and holds CSRF, absolute deadline, optional login attempt, profile/subject,
access/refresh tokens, version, cooldown, verification-pending, in-flight refresh and closing state.
Browser JavaScript receives CSRF and public metadata/profile, never cookie keys or OAuth credentials.
The browser cookie is itself a credential; do not log request cookies or headers.

Cookies use HttpOnly, SameSite=Lax, Path=/, no Domain and Secure for HTTPS.
Random opaque keys do not need a signing secret. Duplicate/malformed/unknown cookies never authenticate.
Anonymous entries live ten minutes. Authenticated entries default to eight hours and never extend on refresh;
without refresh credentials they cannot outlive the access token. Timers clean both entry kinds without background refresh.
Capacity rejects creation with 503 instead of evicting a live session; replacement login can reuse the old slot.

## State and concurrency

One current attempt per browser entry; a new attempt invalidates the previous one. Claims are consumed synchronously
before exchange and remain cancelable while the provider request runs. Login failure/denial preserves an existing identity.
Successful login rotates cookie/CSRF and closes the previous entry. If cancellation, a superseding attempt or a browser disconnect
is detected before publishing the new session, the callback does not create it and attempts to revoke any refresh token received.
Revocation is best effort: network/provider failures can leave it unconfirmed, and access JWTs may remain valid until expiry.

Refresh is single-flight per entry. Replacement credentials are committed before verifying userinfo. Version checks ignore
stale success/failure from superseded tokens. Logout synchronously closes the entry and cancels callbacks, then waits for the
refresh flight and attempts to revoke the latest refresh token. Local data is removed even if revocation fails; logout JSON reports
revokeConfirmed separately. Cookie deletion headers are flushed before a slow revoke response.
Read failures do not clear cookies in late responses, avoiding deletion of a newer login cookie; bootstrap replaces stale keys.

SPA epochs ignore old responses after mutations/session signals. One bootstrap runs at a time; a requested resync is queued.
Mutation buttons prevent duplicate requests. BroadcastChannel sends only `changed`, and foreground revalidation works without it.

## Provider contracts and remaining limits

JWT verification requires RS256, kid, sub, aud, exp, token_use=oauth_access and the expected client audience.
Userinfo _id must match JWT sub and satisfy the seven-field profile contract.
JWT-purpose separation is a Rita ID contract, not a complete OIDC implementation; issuer/discovery are not added.
For an established session, JWKS transport/HTTP/JSON/schema outages return 503 without discarding credentials, allowing verification
to be retried. If refresh has already rotated tokens, the replacement is retained; the old refresh token is never replayed.
During login callback, token verification failure (including a JWKS outage) instead attempts to revoke any newly received refresh token,
creates no new authenticated session and redirects to /?auth=authentication_failed. The new tokens are not retained for retry;
an existing login remains intact if still valid. Invalid signatures/claims are authentication failures, not recoverable JWKS outages.

Rita ID stores OAuth sessions and hashed refresh history in its internal database; that is distinct from this example's token store.
Revoke blocks subsequent refresh but does not immediately invalidate issued access JWTs. Userinfo checks the internal user and
OAuth client/scopes, not the OAuth session revocation state or live HRM. Fields are not filtered by scopes.

<a id="luu-tru-ben-vung"></a>
## Persistence and production boundary

Production is intentionally disabled. Restart loses tokens, attempts and callback coordination. Timers cannot revoke while the
process is down. Multiple workers are unsupported. A future persistent implementation must store all entry state with atomic
replacement/version checks and cross-instance coordination, not just the token pair. Ambiguous provider rotation cannot be made
atomic with a separate storage system; some failures must still require login. No Redis/database adapter is included here.
