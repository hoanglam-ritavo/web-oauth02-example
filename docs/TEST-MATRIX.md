# Verification matrix — 2026-10-18

[README](../README.md) | [Architecture](../ARCHITECTURE.md)

## Executed checks

- Example: ESLint, TypeScript, build, **88/88 Node HTTP/unit tests and Chrome smoke passed**; Chrome headless uses a fictional HTTP provider and RSA/JWKS, never .env.
- Backend: final full Jest run **287 passed / 17 skipped** with disposable PostgreSQL 17, including **12 real SQL tests** for sessions, key-startup concurrency and transaction-connection reuse under concurrent signing. Build, typecheck, full read-only ESLint and docs:check passed (98 links, 2 command-checker tests, 15 Swagger tests).
- Portal: 81 tests in 5 suites passed (auth pages, portal interactions, routing, Axios recovery and serialized login adapter). Portal source was not changed.
- No real account, HRM service or shared database was used. Passing separate suites is not a live end-to-end test across all three applications.

## Automated behavior coverage

| Group | Evidence and cases |
| --- | --- |
| Cookie/bootstrap | [cookie tests](../test/cookie-spa.test.ts): opaque key/hash lookup; metadata contains no key/token; stable reads; malformed/duplicate/unknown/legacy cookie; anonymous/authenticated capacity; TTL cleanup; key and CSRF rotation |
| Login/state | [app tests](../test/app.test.ts), cookie tests: PKCE challenge, fixed callback, missing/wrong/repeated/expired/superseded state, denial, missing code, another browser, simultaneous callbacks, safe callback error codes, JSON test adapter |
| Callback races | cookie tests and [lifecycle](../test/lifecycle.test.ts): abandoned socket, newer login superseding exchange, logout during exchange, replacement login revoking the old grant, old key rejected |
| Identity/guard | [adapter tests](../test/oauth.test.ts), [guard tests](../test/rita-auth.guard.test.ts): subject/profile schema, nullable fields, algorithm/signature/audience/expiry failures; arbitrary Bearer cannot replace cookie; private handler only after successful verification |
| Token purpose | [JWKS recovery](../test/jwks-recovery.test.ts): legacy/missing purpose, SSO, ID and client tokens rejected by example even with valid signature/audience |
| Refresh | lifecycle: automatic/manual, no refresh token, absolute deadline, expiry during userinfo, simultaneous requests sharing one rotation, late old-token response, changed subject, replacement committed before verification |
| Refresh ambiguity | lifecycle: timeout, lost response, malformed JSON, missing replacement, server error; no replay; invalid_grant and integration errors; explicit pre-consumption temporarily_unavailable retry |
| Provider failures | lifecycle and adapter tests: userinfo 401/403/503, invalid JSON/shape, timeout; cooldown, retry with replacement rather than rotating again; pending replacement expiring |
| JWKS outage | JWKS recovery for established sessions: real local HTTP 503/429, timeout, malformed JSON/schema; retained credentials, no revoke/refresh, successful recovery and cache hit |
| Logout | lifecycle/cookie tests: CSRF, expired/missing cookie idempotence, revoke failure, refresh/logout concurrency, latest replacement revoked, callback cancellation, old cookie cannot restore identity |
| Input and routing | cookie tests: wrong Origin, invalid/stale/missing CSRF, parser 400/413, SPA deep links, API/auth/assets 404, same-origin assets and CSP |
| Leakage/XSS | lifecycle/adapter tests and [Chrome smoke](../test/browser-smoke.mjs): token/secret absence from API/HTML/logs/cookie; profile rendered as text; HttpOnly cookie inaccessible to JS; no localStorage/sessionStorage credentials |
| Browser lifecycle | Chrome smoke: browser login against a fictional provider, reload/deep link, query cleanup, automatic/manual refresh, double-click suppression, stable key, 403/offline/503 retention and retry, cross-tab logout, late profile after logout ignored, private UI cleared on 401 |
| Backend boundary | Current backend OAuth eligibility excludes DEVELOPER users. Example parser rejects that group; OAuth access tokens remain distinct from SSO tokens for portal routes. Backend behavior is based on source inspection, not a live backend check here. |
| Profile contract | Parser unit and OAuth/HTTP tests: required avatar and nested position, nullable/empty values, unknown-field stripping, subject matching, malformed payload rejection and profile propagation through callback, /api/me and refresh |
| Signing keys | Backend jwks.service.spec.ts: dynamic active signing kid, retired key validation/JWKS, no private JWK material, multiple-active failure. Real PostgreSQL tests: two service cold starts produce one signing key under advisory lock; twelve simultaneous signing transactions reuse their own connections |
| SQL lifecycle | Backend oauth-session-postgres.spec.ts: real simultaneous code redemption/refresh, replay revocation, rollback on signing/write failures, revoke isolation and direct refresh concurrency in generated disposable schemas |
| Portal contract | Portal tests preserve OAuth params/state/PKCE through login and consent, recover SSO using /auth/refresh, and keep business/transient failures separate from session expiry |

## Remaining environment-dependent checks

The following are **not claimed as executed**:

1. A browser flowing through the running real portal, real Rita ID backend and example together, including an existing SSO cookie and previously granted consent. Use fictional accounts/client in an isolated deployment, test direct API URL and portal /api rewrite, then revoke only those test grants.
2. Actual HTTPS reverse-proxy termination and Secure-cookie delivery in a browser. The HTTP test asserts cookie attributes using forwarded HTTPS; it is not a TLS deployment test.
3. Browser Back/Forward Cache behavior across all supported browsers, tab suspension, browser restart and real network response loss. Epoch/BroadcastChannel/pageshow/visibility handlers are implemented; Chrome automated coverage is not an exhaustive browser compatibility certification.
4. Provider operational key rotation/retirement/compromise response. Fixtures verify key overlap; no admin rotation endpoint or public-key deletion policy is added.
5. The unrelated 17-case HRM PostgreSQL suite was not rerun for this change. Prior historical results in the backend README are not re-attributed to this update.

## Reproducible local commands

From this example: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:browser`.
From the backend: build, TypeScript, read-only ESLint, full Jest and docs:check as documented in its README.
Only set OAUTH_TEST_DATABASE_URL to an explicitly disposable database for the PostgreSQL suite; it never loads application .env.
Keep the backend's generated-schema cleanup. Do not replay real refresh tokens on shared systems.

## Compatibility / rollout acceptance

Backend must issue token_use before the new example is started. Legacy access tokens fail closed; valid direct refresh upgrades SSO,
otherwise sign in again. The old example cookie/session cannot be migrated from RAM. NODE_ENV=production remains rejected.
The example is accepted as a single-process demo, not a persistent or horizontally scalable authentication service.
