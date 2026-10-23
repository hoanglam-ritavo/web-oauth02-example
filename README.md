# Rita OAuth Web and Mobile Backend Example

Static HTML + JavaScript + Axios SPA, served by Express/TypeScript on the same origin.
The web branch is a confidential OAuth client. Rita ID issues the OAuth tokens; the example backend keeps them in RAM.
The browser only holds an opaque HttpOnly cookie. There is no EJS or express-session dependency.

**Mobile backend B** can run independently or alongside the browser SPA. It accepts Mobile A's OAuth handoff,
keeps the replacement tokens server-side and issues an opaque Bearer session key X. Enable it explicitly;
browser login/cookies/CSRF remain separate and unchanged. See [mobile setup, API and lifecycle](docs/mobile-backend.md).

For step-by-step setup see [deployment](docs/deployment.md); choose a [web or mobile flow](docs/flows/README.md).

| Mode | Enabled routes | Credentials |
| --- | --- | --- |
| web | SPA, browser auth/private APIs, health | Confidential web client ID and secret |
| mobile | /api/mobile and health; no SPA/browser auth | Public mobile client ID, no secret |
| both | Both branches with separate stores | Both sets; distinct client IDs |

## Architecture

`Browser cookie -> SHA-256 key lookup -> RAM entry -> OAuth access/refresh tokens`

The cookie is `rita_example.key`, a random 32-byte base64url value, not an OAuth token.
The entry contains CSRF, deadlines, pending state/PKCE, credentials and concurrency state.
See [architecture](ARCHITECTURE.md), [login](docs/flows/web-flows/01-login-and-guard.md),
[private APIs](docs/flows/web-flows/02-private-resource-request.md), [refresh/logout](docs/flows/web-flows/03-refresh-and-session-termination.md)
and the [test matrix](docs/TEST-MATRIX.md).

**Demo only:** one process, RAM store, production startup disabled. Restart loses sessions.
There is no cross-instance refresh lock or persistence. Logging out here does not log out of Rita ID SSO.

## Local setup

Use Node.js 24 and npm. Register a confidential client in the developer portal with authorization_code and refresh_token grants,
scopes `openid profile email`, and exact callback `http://localhost:3003/auth/callback`.
Upgrade the Rita ID backend with token-purpose enforcement before running this example.

```powershell
npm ci
# Never overwrite an existing local configuration.
if (!(Test-Path .web.env)) { Copy-Item .web.env.example .web.env }
# Fill the fictional placeholders in .web.env before starting.
npm run dev:web
```

Configure the client ID/secret in your local .web.env; never commit real credentials.
Open http://localhost:3003. Do not mix localhost with 127.0.0.1 during a login.

| Variable | Default / requirement |
| --- | --- |
| EXAMPLE_MODE | web, mobile or both; explicit mode overrides the legacy flag |
| NODE_ENV | development/test; production rejected |
| PORT | Parser default 3003 in every mode; mobile profile template explicitly sets 3004 |
| APP_BASE_URL | http://localhost:3003; origin only |
| RITA_PORTAL_URL | http://localhost:3000; origin only |
| RITA_API_URL | http://localhost:3000/api; optional path prefix |
| RITA_CLIENT_ID | Required in web/both: confidential client ID |
| RITA_CLIENT_SECRET | Required in web/both, server-only |
| SESSION_MAX_AGE_HOURS | 8; greater than 0 and at most 24 |
| MAX_SESSION_ENTRIES | 10000; positive safe integer |
| HOST | 127.0.0.1; listen hostname/IP, does not change APP_BASE_URL/callback/proxy trust |
| MOBILE_AUTH_ENABLED | Legacy only when EXAMPLE_MODE is absent: true selects both, false/absent selects web; invalid values rejected |
| RITA_MOBILE_CLIENT_ID | Required in mobile/both; public client, different from browser client in both |
| MOBILE_SESSION_MAX_AGE_HOURS | 8; greater than 0 and at most 24; absolute mobile lifetime |
| MOBILE_MAX_SESSION_ENTRIES | 1000; positive safe integer, includes reservations |
| MOBILE_MAX_HANDOFF_ENTRIES | 2000; positive safe integer, includes replay/tombstones |

SESSION_SECRET is obsolete and ignored. Legacy `rita_example.sid` cookies are cleared; old sessions are not migrated.
`RITA_API_URL=http://localhost:4000` calls Rita ID directly; the default uses the portal /api rewrite.
Server-to-server OAuth requests do not need browser CORS. The server listens on loopback by default (HOST);
HTTPS requires a loopback reverse proxy with X-Forwarded-Proto. Secure cookies follow APP_BASE_URL.

## Separate mobile process and legacy startup

Use [.web.env.example](.web.env.example) for web and [.mobile.env.example](.mobile.env.example) for mobile.
The mobile profile needs only a public client ID, with no browser secret, portal origin or callback configuration in B.
Register the mobile callback on Rita ID as described in the [mobile guide](docs/mobile-backend.md).

```powershell
if (!(Test-Path .mobile.env)) { Copy-Item .mobile.env.example .mobile.env }
# Fill the public-client placeholder before starting.
npm run dev:mobile
```

Run dev:web and dev:mobile in separate terminals: templates listen on 3003 and 3004 respectively.
Point A's EXPO_PUBLIC_APP_BACKEND_BASE_URL at the mobile process origin, e.g. http://10.0.2.2:3004
for an Android emulator accessing its host, or http://<computer-LAN-IP>:3004 on a physical device.
For LAN access configure the mobile HOST appropriately and allow the test port through the firewall.
Release A requires HTTPS through a reverse proxy. This does not enable production mode in B.

After npm run build, use npm run start:web or npm run start:mobile. Profile commands require the matching
.web.env or .mobile.env at the project root, including when running dist from another directory.
They never load .env or fall back to another file. Process environment overrides file values; the resulting
EXAMPLE_MODE must match the selected profile. Only a single --profile=web or --profile=mobile argument is accepted.

Legacy npm run dev / npm start still load root .env if present; process-only configuration is also supported.
Without EXAMPLE_MODE, MOBILE_AUTH_ENABLED=true selects both, false/absent selects web.
An explicit EXAMPLE_MODE overrides the legacy flag entirely. Use legacy commands with EXAMPLE_MODE=both
and both credential sets to run the combined process; both client IDs must differ.
Only settings for active branches are validated. No local environment file is generated or migrated automatically.

All modes expose /health. Disabled branch routes return JSON 404 without cookies or redirects.
Mobile-only does not serve SPA/assets or register browser cookie/CSRF middleware, and does not enable trust proxy.
Web/both retain the existing HTTPS cookie and loopback-proxy policy. RAM limits and the production block apply to every mode.

## HTTP contract

The table below describes web/both routes plus shared health. Mobile endpoints and exact fields are listed in the [mobile HTTP contract](docs/mobile-backend.md#http-contract).

| Method | Path | Behavior |
| --- | --- | --- |
| GET | / and extensionless navigation paths | Static SPA shell, no embedded identity/CSRF |
| GET | /api/session | 200 `{ authenticated, csrf, session }`; creates anonymous entry when needed |
| GET | /auth/login | Bind one state/PKCE attempt and redirect to portal |
| GET | /auth/callback | Consume attempt, exchange/verify, rotate cookie, redirect to `/?auth=<safe-code>` |
| GET | /api/me | Guard and fresh userinfo profile |
| GET | /api/private/example | Guard and `{ message, subject }` |
| POST | /auth/refresh | `{ csrf }` -> `{ profile, session }` |
| POST | /auth/logout | `{ csrf }` -> `{ loggedOut: true, revokeConfirmed }` |
| GET | /health | `{ status: "ok" }`; no provider call |

Session metadata contains expiry times, canRefresh, scopes, refreshCount, lastRefreshAt and verificationPending.
Bootstrap is local metadata, not proof of current provider authorization. Every protected handler uses the guard.
JSON API errors are `{ error }`: 400 invalid body; 401 not_authenticated; 403 forbidden/invalid_csrf/invalid_origin;
409 refresh_unavailable; 413 body_too_large; 502 integration_error; 503 temporarily_unavailable/store_full with Retry-After.
Unknown API/auth/assets return 404, never SPA HTML. Auth/private/bootstrap responses use no-store.
Refresh/logout accept JSON or URL-encoded bodies but always return JSON; old form redirect behavior is removed.
An injected JSON callback mode is retained for isolated integration tests; the running server uses redirects.

The example requires the current Rita ID `/auth/oauth/userinfo` contract: all nine fields
`_id`, `name`, `email`, `employee_id`, `phone_number`, `is_developer`, `groups`, `avatar` and `position`
must be present. `_id` must match the verified JWT subject and is exposed as `sub`.
`avatar`, `employee_id` and `phone_number` are strings or null.
`position` contains `text` (string or null) and `parser`, with string categories
`group`, `company`, `department`, `board`, `region`, `store`, `warehouse`, `factory`,
`workshop`, `showroom`, `center`, `cafe`, plus `others` (an array of strings).
Empty categories are empty strings; an unavailable position uses null text and an empty parser.
The example preserves these values without reparsing text, strips unknown fields at every level,
and rejects missing or mistyped fields rather than filling defaults for older backend versions.
OAuth profiles accept `EMPLOYEE`, `CUSTOMER` and `ENTERPRISE`; `DEVELOPER` is excluded by the
backend OAuth eligibility policy. `/api/me`, refresh and JSON callback responses include the
new profile fields. Provider 503 responses remain temporary failures, not empty profiles.

The SPA keeps CSRF only in memory, never reads the HttpOnly cookie and never replays a POST automatically.
401 clears private UI without redirect loops. Transient, network, 403 and configuration errors remain visible.
BroadcastChannel carries only a change signal; foreground/BFCache/online events re-bootstrap the session.

## Verification and rollout

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:browser
npm run test:mobile-compat
npm run docs:check
```

Browser tests build first and run Chrome headless against a fictional HTTP provider, without loading .env.
Set SMOKE_EXAMPLE_MODE=both to repeat Chrome smoke with both branches enabled (default web).
Set CHROME_PATH if Chrome is not at its default Windows path. The script prints its temporary profile path.
Build serves only static public assets and the bundled Axios script; it does not depend on the working directory.

Upgrade backend first, then portal if required, then restart this example. Access tokens missing `token_use` are rejected;
valid Rita ID refresh tokens can obtain new-purpose tokens, otherwise users sign in again.
Deploying this example invalidates the old RAM sessions and cookie format. Do not roll back to an unsafe token boundary.

Current verification on 2026-10-23 is recorded in [the test matrix](docs/TEST-MATRIX.md#current-verification-status).
`test:mobile-compat` explicitly requires the sibling Mobile Example (or MOBILE_EXAMPLE_PATH); regular build/tests do not.
All sessions remain RAM-only, including mobile; production is still disabled. Mobile token acceptance establishes
subject/client/scope consistency by refresh, not proof that the original pair came from the same OAuth grant.
Historical pre-SPA baseline on 2026-10-17: 69 tests, typecheck, build and Chrome smoke passed with a fictional provider.
Neither that baseline nor current isolated tests establishes live HRM, deployment TLS, or full three-repository browser compatibility.
