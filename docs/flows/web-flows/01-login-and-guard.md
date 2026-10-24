# Login and guard

[README](../../../README.md) | [Architecture](../../../ARCHITECTURE.md)

1. SPA requests GET /api/session. Backend returns an anonymous CSRF token and sets the HttpOnly cookie key when needed.
2. GET /auth/login stores state, verifier, expiry and one-use/cancellation flags in the same RAM entry.
3. Portal preserves state/PKCE through SSO login and calls Rita ID authorize/consent. Backend validates exact registered redirect.
4. Callback checks cookie binding and consumes state before token exchange. Wrong/missing/repeated/expired state never exchanges code.
5. Example verifies RS256, kid, purpose, audience, expiry and userinfo subject before creating an authenticated entry.
6. It rotates cookie/CSRF, closes the previous entry and redirects to /?auth=success. Errors redirect with allowlisted codes only.
7. SPA removes the result query from history, bootstraps metadata and loads profile. No token reaches frontend storage.

Denied or failed re-login preserves the previous identity if still valid. New attempts supersede old ones.
If logout, a superseding attempt or a browser disconnect is detected before publishing the new session, the callback does not create it
and attempts to revoke any refresh token received. This is best effort: network/provider failures can leave revocation unconfirmed.
Access JWTs may remain valid until expiry even when refresh-token revocation succeeds.

Token verification failure during callback, including a temporary JWKS outage, attempts the same cleanup and redirects to
/?auth=authentication_failed without retaining the new tokens for retry. An existing login is preserved if still valid.
The 503-and-retain behavior described in the [refresh flow](03-refresh-and-session-termination.md) applies to established sessions.

A protected API cannot authenticate from an arbitrary Bearer header; it must resolve the browser cookie entry.
Use the shared RitaAuthGuard before business handlers, and add business-specific permissions and CSRF for write endpoints.

## Participants and prerequisites

Browser SPA, example backend and Rita ID participate in this flow. Enable web or both mode and configure the confidential client and exact callback using the [deployment guide](../../deployment.md). Protected resources require an authenticated cookie entry; refresh/logout also enforce their documented CSRF rules.

## Implementation and evidence

See [implementation](../../../src/auth/rita-auth.strategy.ts), [flow regression](../../../test/app.test.ts), [cookie/SPA tests](../../../test/cookie-spa.test.ts) and [Chrome smoke](../../../test/browser-smoke.mjs). These use fictional providers; [current verification](../../TEST-MATRIX.md#current-verification-status) distinguishes executed checks from live acceptance.
