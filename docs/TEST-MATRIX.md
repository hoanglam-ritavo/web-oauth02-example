# Web and mobile verification matrix

[README](../README.md) | [Architecture](../ARCHITECTURE.md) | [Deployment](deployment.md) | [Flows](flows/README.md)

## Current verification status

Documentation/flow/regression maintenance on **2026-10-23**, revision c796582 plus the pre-existing working tree. Scope: Markdown, flow relocation, regression tests, documentation checker and its npm script. Runtime, dependencies, local env and sibling sources are unchanged by this task.

| Check | Result |
| --- | --- |
| `npm run lint` | Passed. |
| `npm run typecheck` | Passed after correcting an optional response-header type in the new test. |
| `npm test` | 140 passed, 0 failed, 0 skipped; includes four checker fixtures and source startup checks. |
| `npm run build` | Passed; also run by each Chrome smoke command. |
| `npm run docs:check` | Four fixture tests passed; 12 Markdown files and 142 local links/anchors checked, with current npm scripts and explicit command paths validated. |
| `npm run test:browser` | Chrome passed in web and both modes against a fictional provider. |
| `npm run test:mobile-compat` | Passed using the actual sibling A adapter, local B HTTP and fictional RSA/JWKS provider. |
| Dist startup | 2 passed, 0 failed/skipped with TEST_STARTUP_ARTIFACT=dist; copied artifacts and fictional profile files from unrelated cwd. |
| Diff and scope review | `git diff --check` passed with LF/CRLF conversion warnings; new files also checked for trailing whitespace. Runtime, lockfile, templates, gitignore and existing compatibility-script hashes match the task-start snapshot. |

The initial sandbox docs-check attempt failed with subprocess `spawn EPERM`; the permitted rerun passed. Regression, startup, Chrome and compatibility runs used permitted subprocess/loopback access. No runtime defect was exposed by the added assertions. Earlier pass counts below remain historical, not results of this update.

Not executed: native devices/deep links, live Rita ID/HRM, client provisioning, real LAN/firewall or TLS/reverse-proxy deployment. These tests use fictional data, not real local env or shared databases. RAM-only/single-process/production-block limitations and the original-grant-binding limit remain.

## Current coverage

| Area | Evidence | Boundary |
| --- | --- | --- |
| Shared OAuth/profile | [OAuth tests](../test/oauth.test.ts), [profile](../test/profile.test.ts), [JWKS recovery](../test/jwks-recovery.test.ts), [lifecycle](../test/lifecycle.test.ts) | Fictional tokens/providers; schema, purpose, refresh uncertainty and concurrency, not live Rita compatibility. |
| Web | [App](../test/app.test.ts), [cookie/SPA](../test/cookie-spa.test.ts), [guard](../test/rita-auth.guard.test.ts), [Chrome](../test/browser-smoke.mjs) | Cookie/state/CSRF, safe UI and logout; Chrome runs separately in web and both. |
| Mobile | [Mobile regressions](../test/mobile.test.ts), [HTTP/RSA](../test/mobile-http.test.ts) | Handoff/replay, accepted identity/client/scope consistency, GET response/POST rejection, refresh/logout and isolation; no original-grant binding proof. |
| Mode/config/startup | [Environment](../test/environment.test.ts), [startup](../test/startup.test.ts) | web/mobile/both route matrix; source and dist profile startup from unrelated cwd using temporary fictional files. |
| A compatibility | [Compatibility script](../scripts/test-mobile-compat.mjs) | Actual A adapter against B HTTP and fictional RSA/JWKS; no native browser/deep link or real account. |
| Documentation | [Checker](../scripts/check-docs.mjs), [checker fixtures](../test/docs-check.test.ts) | Local links/anchors, current commands/paths, flow relocation; no remote URL availability check. |

## Current validation commands

Run from this project root with installed dependencies. Do not start the real app or load local .env for validation.

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run docs:check
npm run test:browser
npm run test:mobile-compat
git diff --check
```

Use dedicated shells for these overrides so they do not affect later commands:

```powershell
$env:SMOKE_EXAMPLE_MODE='both'
npm run test:browser
```

```powershell
$env:TEST_STARTUP_ARTIFACT='dist'
node --import tsx --test test/startup.test.ts
```

Build before the dist startup check. Chrome defaults to the installed Windows path; CHROME_PATH selects another executable. Tests require subprocess/loopback access. Compatibility needs the adjacent Mobile A checkout or MOBILE_EXAMPLE_PATH. Report unavailable environments explicitly; mocks do not replace those checks.

The docs checker scans root Markdown and docs recursively. It validates inline local links, heading slugs (including duplicates) and HTML anchors; fenced/inline code is excluded from link discovery. Current npm scripts and explicit test/script file references are checked against their owning package. To switch command ownership, use a docs:project HTML comment containing a root-relative project path, then reset to a dot for this project. Historical start/end markers exclude old commands/paths only; historical links remain checked. Keep such markers limited to preserved dated records.

## Historical verification records

The following content preserves earlier observations and counts. Their operational statements describe those revisions and do not override the current deployment guide. No backend or portal check below is attributed to this task.

<!-- docs:historical:start -->

# Web/mobile runtime separation verification ? 2026-10-23

[README](../README.md) | [Architecture](../ARCHITECTURE.md) | [Mobile contract](mobile-backend.md)

## Historical runtime separation snapshot

Revision c796582 plus the pre-existing phase-2 working tree and this profile/mode update. Scope: OAuth Web Example only;
new environment templates/loader/scripts, conditional config/runtime, browser config type consumers, fixtures/tests and documentation.
No real local environment files were read, created or modified; no dependencies, lockfile or sibling source changes.

| Check | Result |
| --- | --- |
| npm run lint; npm run typecheck | Passed |
| npm test | 133 passed, 0 failed, 0 skipped |
| npm run build | Passed, including both browser smoke builds |
| npm run test:browser | Chrome passed in web and both; both selected with SMOKE_EXAMPLE_MODE=both |
| npm run test:mobile-compat | Actual A adapter passed against mobile-only B with no browser credentials and fictional RSA/JWKS provider |
| TEST_STARTUP_ARTIFACT=dist node --import tsx --test test/startup.test.ts | 2 passed: copied dist artifacts, isolated fictional profile files, unrelated cwd, safe startup logs |
| Markdown links and git diff --check | Passed |

Coverage adds profile isolation/no fallback, process precedence, missing/malformed/duplicate profile and mode mismatch,
legacy mode selection, inactive-setting validation, template parsing, Git ignore rules, no browser cookies/SPA/proxy in mobile-only,
and disabled-mobile JSON 404 in web-only. HTTP mobile lifecycle runs in mobile and both; browser Chrome lifecycle runs in web and both.
Source startup fixtures are part of npm test; the separate dist run confirms built root resolution. Fixture startup never loads real .env.
The initial sandbox test attempt hit child-process EPERM; the authorized rerun with subprocess/loopback access passed.

Not tested: native devices/deep links, live Rita ID/HRM, client provisioning, real LAN/firewall or HTTPS reverse proxy.
RAM-only single-process and production-block limitations remain. Mock and Chrome evidence does not establish those integrations.

## Historical phase-2 verification (before profile separation)

# Phase-2 mobile backend verification — 2026-10-23

[README](../README.md) | [Architecture](../ARCHITECTURE.md) | [Mobile contract](mobile-backend.md)

## Phase-2 verification snapshot

Verified against revision `c796582` plus the mobile-backend working tree (configuration, shared OAuth adapter, isolated mobile router/store, tests, compatibility script and docs). Existing browser source behavior and assertions were retained. No dependency/lockfile changes, local .env changes, database changes or edits to sibling sources were made.

| Check | Result |
| --- | --- |
| npm run lint | Passed |
| npm run typecheck | Passed |
| npm test | 125 passed, 0 failed, 0 skipped |
| npm run build | Passed (also run by test:browser) |
| npm run test:browser | Chrome headless passed against fictional provider: SPA, login, cookie/CSRF, refresh, 503 recovery, cross-tab logout, 401 UI |
| npm run test:mobile-compat | Existing Mobile A adapter passed against B HTTP and fictional RSA/JWKS provider: handoff/replay/profile/private resource/refresh/logout |
| git diff --check and local Markdown links | Passed; Git LF/CRLF warnings only |

Tests use fake accounts/providers, including real localhost HTTP and RSA/JWKS verification. They do not load .env. Browser smoke uses a temporary Chrome profile and reports its location. Worker/browser/local-server tests require an environment permitting subprocesses and loopback listeners.

Mobile coverage includes exact schemas, native/browser isolation, 16 KB versus 4 KB parsers, Origin denial, duplicate Bearer rejection, idempotency/concurrency/conflicts, token audience/signature/purpose/expiry/scope/identity, public client without secret, ambiguous refresh termination, verification-only recovery, timer cleanup/tombstones/capacity, logout during refresh and late replacement cleanup. No test was skipped or weakened to preserve browser compatibility.

Unverified: native-device installation/browser/deep-link flow, live Rita ID/HRM, configured public-client provisioning, TLS/proxy/device reachability and multiple production instances. The system remains a RAM-only single-process demo with production disabled. Original access/refresh grant identity is not provable by the current Rita token format; accepted consistency is subject/client/scope only.

---

The remainder preserves the previous dated verification snapshot; it is not a claim that its backend/portal checks were rerun in phase 2.

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

<!-- docs:historical:end -->
