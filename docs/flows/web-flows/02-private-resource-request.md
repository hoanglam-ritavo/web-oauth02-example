# Private API request

[README](../../../README.md) | [Architecture](../../../ARCHITECTURE.md)

Browser Axios sends the HttpOnly cookie automatically to the same origin. Cookie middleware hashes the key and finds one RAM entry.
The guard clears any stale req.auth, checks local lifetime, verifies the current access JWT and loads fresh userinfo before next().
req.auth contains only profile and expiry. The handler never receives credentials.

Expired access can trigger one shared refresh. Concurrent requests reuse that flight; late results from a prior token version are ignored.
Local absolute expiry, closing state and subject are checked before allowing the handler. Metadata bootstrap alone does not authorize access.

401 ends local authentication and clears the SPA's private UI. 403 denies the operation without token rotation. 502 identifies integration
configuration. 503/network errors allow explicit retry and do not replay the original business request. The SPA is static on reload and deep
links; API/auth/assets 404s never fall back to HTML. Responses containing private state are no-store.

## Participants and prerequisites

Browser SPA, example backend and Rita ID participate in this flow. Enable web or both mode and configure the confidential client and exact callback using the [deployment guide](../../deployment.md). Protected resources require an authenticated cookie entry; refresh/logout also enforce their documented CSRF rules.

## Implementation and evidence

See [implementation](../../../src/auth/rita-auth.guard.ts), [flow regression](../../../test/rita-auth.guard.test.ts), [cookie/SPA tests](../../../test/cookie-spa.test.ts) and [Chrome smoke](../../../test/browser-smoke.mjs). These use fictional providers; [current verification](../../TEST-MATRIX.md#current-verification-status) distinguishes executed checks from live acceptance.
