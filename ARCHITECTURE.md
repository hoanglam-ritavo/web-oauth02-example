# OAuth Web and Mobile Backend Architecture

[README](README.md) | [Deployment](docs/deployment.md) | [Flow index](docs/flows/README.md) | [Test matrix](docs/TEST-MATRIX.md)

## Runtime selection

The environment loader reads a single root file: .web.env or .mobile.env for explicit profiles, otherwise legacy .env.
Process variables override the selected file; a profile requires a matching EXAMPLE_MODE and never falls back.
Source and dist resolve the same project root independently of the current working directory.
The config union has common provider/listener settings plus web, mobile or both branches; inactive settings are not validated.

Web registers the browser adapter/store, SPA, cookies, CSRF and browser routes. Mobile registers only the public-client
adapter/store and /api/mobile router. Both registers separate instances for both branches. Shared OAuth transport,
RS256/JWKS/profile checks and session lifecycle logic are reused. All modes retain security headers, no-store and /health.
Disabled routes return JSON 404 before browser session creation; mobile-only has no browser config or proxy trust.
See [startup commands and legacy compatibility](README.md#separate-mobile-process-and-legacy-startup).

## Components

- Express serves static HTML/CSS/JavaScript, local Axios and JSON endpoints on one origin.
- Each OAuthSessions instance owns a Map of anonymous/authenticated entries. Browser and optional mobile use separate instances and client credentials; no secondary Express session store exists.
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

The [web flows](docs/flows/README.md#web-flows) and [mobile flows](docs/flows/README.md#mobile-flows) document request sequences and failure branches; this section records the shared ownership and concurrency rules.

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
Userinfo _id must match JWT sub and satisfy the profile contract, including avatar and the nested position parser.
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

## Optional mobile backend B

The [mobile implementation guide](docs/mobile-backend.md) defines configuration, wire contracts and the accepted token-binding limit. EXAMPLE_MODE selects web/mobile/both. Without it, legacy MOBILE_AUTH_ENABLED defaults false (web), while true selects both.

Mobile routes mount before browser body/cookie middleware and use a separate 16 KB parser/error boundary. They never generate browser cookies or accept cookies as authentication. Native Bearer keys and browser cookie keys are isolated by separate OAuthSessions instances and OAuth client configurations. The public mobile adapter never sends the confidential browser secret. The browser adapter retains its prior inputs/outputs.

The handoff manager reserves capacity before rotating, proves subject/client/scope consistency using original and replacement JWT/userinfo, then transfers replacement credential ownership to the mobile session store. Per-process HMAC fingerprints prevent duplicate consumption and AES-GCM protects the short-lived replay response containing X. Replay is bounded to 150 seconds and cannot restore a logged-out session. Pending/terminal/replay records have bounded timers and capacity; no eviction of active state is used to admit new sessions.

JWTs have no original-grant/session linkage, so two valid grants for the same subject/client/scope set cannot be distinguished. Missing refresh responses remain terminal: B never blindly retries a potentially consumed refresh token. Known replacements awaiting verification are retained and verified again without a second rotation.

The mobile session deadline defaults to eight hours and does not slide; cleanup revokes best-effort. Process loss clears keys, replay encryption/HMAC keys and sessions, but cannot guarantee provider revocation. Live credentials remain in RAM, and no production persistence/distributed coordination is introduced. HOST controls binding only; TLS/reverse-proxy and device reachability are external setup tasks.
