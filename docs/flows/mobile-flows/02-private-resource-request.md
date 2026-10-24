# Mobile private resource request

[Flow index](../README.md) | [Deployment](../../deployment.md) | [HTTP contract](../../mobile-backend.md#http-contract)

## Participants and prerequisites

A holds an unexpired X issued by this B process. B runs mobile or both mode and can reach Rita ID. Cookies cannot authenticate mobile, and mobile X cannot authenticate the web store.

## Successful flow

1. A validates its locally stored origin/expiry and sends `Authorization: Bearer X`. Startup/foreground use GET `/api/mobile/me`; the current demo resource is GET `/api/mobile/private/example`.
2. B requires exactly one correctly formatted Bearer header, hashes X and resolves its own session. A submitted profile or browser cookie is not identity proof.
3. B checks local lifetime/closing state, verifies OAuth access proof and fresh userinfo, and performs a shared refresh when needed. Subject remains fixed for the session.
4. `/me` returns only profile and expiresAt. The private example returns exactly message and subject. Neither response includes OAuth credentials, cookie keys, CSRF or internal refresh counters; responses are no-store with no Set-Cookie.
5. A validates identity responses before display. Its generic private helper returns unknown JSON for the caller to validate.

## Failures and concurrent requests

401 ends A's current session; 403 denies permission without silently replaying requests. Temporary provider errors preserve recoverable state and return 503; configuration errors return 502. Concurrent refresh shares one rotation and stale token-version results cannot overwrite newer credentials. A never refreshes OAuth tokens itself or automatically replays a business request.

Unknown methods/paths return JSON 404 before parsing the body, including POST to `/api/mobile/private/example`; no mobile refresh or callback endpoint exists. Origin headers are rejected. Mobile uses its own 16 KB parser and does not relax the browser 4 KB limit. In web-only mode the whole mobile branch returns 404 without cookies.

## Implementation and evidence

[Router](../../../src/mobile/routes.ts), [handoff/session adapter](../../../src/mobile/mobile-sessions.ts), [shared session lifecycle](../../../src/auth/oauth-sessions.ts) and [profile parser](../../../src/auth/oauth-client.ts) own the behavior. [HTTP tests](../../../test/mobile-http.test.ts) check exact GET response, POST rejection and refresh in mobile/both; [mode tests](../../../test/environment.test.ts) check disabled branches; [mobile regressions](../../../test/mobile.test.ts) check isolation and parser boundaries. Fictional-provider results do not establish LAN, TLS or device behavior.
