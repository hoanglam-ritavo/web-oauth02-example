# Running the web and mobile demos

[README](../README.md) | [Architecture](../ARCHITECTURE.md) | [Flows](flows/README.md) | [Verification](TEST-MATRIX.md#current-verification-status)

## Prerequisites and boundaries

Use Node.js 24 and npm from this project root. Install with `npm ci`. Rita ID must support OAuth access-token purpose enforcement (`token_use=oauth_access`), RS256/JWKS, the current userinfo profile, refresh and revoke contracts. Provision fictional test clients/accounts through your environment's supported process; this example does not provision them.

This is a single-process RAM demo. `NODE_ENV=production` is rejected in every mode; HTTPS does not remove that restriction. Restart loses sessions and handoff replay state, and cannot guarantee revocation of credentials previously held in memory. Do not deploy multiple workers or describe these instructions as production provisioning.

## Web profile

Register a confidential client with authorization_code and refresh_token grants, scopes `openid profile email`, and callback `http://localhost:3003/auth/callback` for the default local setup.

```powershell
if (!(Test-Path .web.env)) { Copy-Item .web.env.example .web.env }
# Edit placeholders and provider URLs in .web.env before starting.
npm run dev:web
```

Set RITA_CLIENT_ID and RITA_CLIENT_SECRET only on the server. APP_BASE_URL must be the actual browser origin; the callback is that origin plus `/auth/callback`. RITA_PORTAL_URL is the browser-facing portal origin. RITA_API_URL is reached by B and can use a path prefix: the template uses `http://localhost:3000/api`; `http://localhost:4000` illustrates direct backend access. Confirm actual service ports and proxy routing in your environment.

The template listens on `127.0.0.1:3003`. Open `http://localhost:3003`; keep the same hostname throughout login. PORT/HOST do not rewrite APP_BASE_URL or the registered callback. The browser receives an HttpOnly cookie, never OAuth credentials. See [web login](flows/web-flows/01-login-and-guard.md).

## Mobile profile and device access

Register a separate public mobile client with the same grants/scopes and exact callback `rita-id-app://redirect`. A owns that callback and code exchange; B needs only RITA_MOBILE_CLIENT_ID and provider connectivity, not a browser client secret, portal origin or callback setting.

```powershell
if (!(Test-Path .mobile.env)) { Copy-Item .mobile.env.example .mobile.env }
# Configure RITA_MOBILE_CLIENT_ID and RITA_API_URL before starting.
npm run dev:mobile
```

The mobile template explicitly sets PORT=3004. The parser default is 3003 in every mode when PORT is omitted. Set A's EXPO_PUBLIC_OAUTH_CLIENT_ID to the same public ID and EXPO_PUBLIC_APP_BACKEND_BASE_URL to B's device-reachable origin without `/api`.

| Caller | Example destination for B | Listener requirement |
| --- | --- | --- |
| Standard Android emulator on this computer | `http://10.0.2.2:3004` | Host loopback listener normally suffices; verify emulator routing. |
| Physical phone on test LAN | `http://<computer-LAN-IP>:3004` | Bind a reachable interface, e.g. HOST=0.0.0.0, and allow the test port through the firewall. |
| Installed release A | HTTPS origin for B | Reachable TLS termination; A rejects HTTP outside development. |

`0.0.0.0` is a bind address, not a client destination. A phone's localhost is the phone itself. A's Rita Portal origin must also be reachable from its system browser. B's RITA_API_URL uses server-side networking and need not use the same hostname as A. See the sibling [Mobile A setup](../../oauth02-mobile-integration-example/README.md#configuration-and-native-setup) for native builds and public environment variables.

Run web and mobile profiles in separate terminals for independent processes/ports. Their RAM state and environment files are independent.

## Compiled startup and combined mode

Build once from this root, then select one command per terminal:

```powershell
npm run build
# Web terminal:
npm run start:web
# Mobile terminal:
npm run start:mobile
```

Build includes public assets and Axios. Source and dist resolve profile files relative to the project root, regardless of process cwd. Explicit profiles require their matching `.web.env` or `.mobile.env`; neither loads `.env` or falls back to another file. Process environment overrides file values, and the resulting EXAMPLE_MODE must match the profile. Use only one `--profile=web` or `--profile=mobile` argument.

For a combined process, use legacy startup with EXAMPLE_MODE=both and both credential sets; the two client IDs must differ. In a dedicated shell, populate environment variables or a local root `.env` with the settings below, using real test registration values instead of placeholders:

```dotenv
EXAMPLE_MODE=both
NODE_ENV=development
PORT=3003
HOST=127.0.0.1
APP_BASE_URL=http://localhost:3003
RITA_PORTAL_URL=http://localhost:3000
RITA_API_URL=http://localhost:3000/api
RITA_CLIENT_ID=replace-with-confidential-client-id
RITA_CLIENT_SECRET=replace-with-confidential-client-secret
RITA_MOBILE_CLIENT_ID=replace-with-public-mobile-client-id
```

Then run `npm run dev`, or `npm start` after building. Do not overwrite an existing `.env`, and do not run another process on the same port. There is no `.env.example` or `--profile=both`; the two tracked templates are [.web.env.example](../.web.env.example) and [.mobile.env.example](../.mobile.env.example).

Legacy startup loads root `.env` if present and also permits process-only settings. Without EXAMPLE_MODE, MOBILE_AUTH_ENABLED=true selects both; false/absent selects web. An explicit mode overrides the legacy flag. Only active-branch settings are validated. No command automatically creates or migrates local config files. Keep secrets out of committed files and command output.

## HTTPS and readiness

For a controlled HTTPS web demo, use the HTTPS APP_BASE_URL, register its exact callback and terminate TLS at a loopback reverse proxy that forwards X-Forwarded-Proto correctly. Web/both trust loopback proxies when Secure cookies are enabled. Mobile-only enables no Express proxy trust; TLS/device access is external infrastructure. HOST does not configure TLS or proxy trust. Validate actual certificate trust and cookie delivery separately; no real TLS test is implied by forwarded-header tests.

```powershell
Invoke-RestMethod http://localhost:3003/health
# In the separate mobile profile:
Invoke-RestMethod http://localhost:3004/health
```

Health returns `{ "status": "ok" }` without contacting Rita ID. In web mode, mobile APIs return JSON 404. In mobile mode, `/`, assets and browser auth APIs return JSON 404; `/api/mobile/me` without X returns 401. These establish route composition, not provider readiness. Use the [flow acceptance scenarios](TEST-MATRIX.md#current-coverage) for isolated integration and manual live checks.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Missing profile file or mode mismatch | Create only the selected profile file; inspect process-level EXAMPLE_MODE overrides. There is no fallback. |
| Address already in use | Stop the conflicting demo or choose another PORT; update browser origin/callback or A's destination as needed. |
| Invalid callback/state or login loop | Match registered callback, APP_BASE_URL and browser hostname; restart cannot restore a RAM attempt. |
| Cookie absent or CSRF 403 | Use the same origin, correct HTTPS/proxy setup and current bootstrap CSRF; do not reuse stale state from a prior login. |
| Mobile 403 invalid_origin | Native APIs reject Origin headers; browser JavaScript is not a supported caller for these endpoints. |
| Mobile cannot connect | Check bind interface, LAN/firewall, emulator mapping, device-trusted HTTPS and origin without a path. |
| 502/503 provider errors | Check server-side API/JWKS reachability and client configuration; preserve error distinctions and do not blindly replay refresh tokens. |
| 401 after B restart | RAM sessions are gone; start a fresh login. A local X cannot reconstruct B's state. |

Validate web and mobile login, private access, refresh, logout, expiry and restart separately. Native installation/deep links, real provider/client provisioning, LAN/firewall and TLS remain environment-dependent acceptance, not outcomes of unit or Chrome tests.
