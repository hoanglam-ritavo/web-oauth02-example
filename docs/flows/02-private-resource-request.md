# Private API request

[README](../../README.md) | [Architecture](../../ARCHITECTURE.md)

Browser Axios sends the HttpOnly cookie automatically to the same origin. Cookie middleware hashes the key and finds one RAM entry.
The guard clears any stale req.auth, checks local lifetime, verifies the current access JWT and loads fresh userinfo before next().
req.auth contains only profile and expiry. The handler never receives credentials.

Expired access can trigger one shared refresh. Concurrent requests reuse that flight; late results from a prior token version are ignored.
Local absolute expiry, closing state and subject are checked before allowing the handler. Metadata bootstrap alone does not authorize access.

401 ends local authentication and clears the SPA's private UI. 403 denies the operation without token rotation. 502 identifies integration
configuration. 503/network errors allow explicit retry and do not replay the original business request. The SPA is static on reload and deep
links; API/auth/assets 404s never fall back to HTML. Responses containing private state are no-store.
