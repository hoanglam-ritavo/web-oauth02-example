# Authentication flow index

[README](../../README.md) | [Deployment](../deployment.md) | [Architecture](../../ARCHITECTURE.md) | [Verification](../TEST-MATRIX.md#current-verification-status)

Choose the flow by the caller's credential, not the process name. Web mode serves browser cookies/CSRF, mobile mode serves native Bearer X, and both mode mounts both branches with separate stores and client credentials. Neither branch accepts the other branch's session key.

## Web flows

1. [Login and guard](web-flows/01-login-and-guard.md): browser bootstrap, PKCE callback, cookie rotation and guard.
2. [Private resource request](web-flows/02-private-resource-request.md): same-origin cookie, fresh identity checks and error handling.
3. [Refresh and termination](web-flows/03-refresh-and-session-termination.md): automatic/manual refresh, CSRF logout and tab concurrency.

## Mobile flows

1. [Login and handoff](mobile-flows/01-login-and-handoff.md): A obtains OAuth tokens; B validates/transfers ownership and issues X.
2. [Private resource request](mobile-flows/02-private-resource-request.md): A sends X, B verifies identity and refreshes as needed.
3. [Refresh and termination](mobile-flows/03-refresh-and-session-termination.md): server-owned rotation, replay invalidation and logout.

The [mobile contract](../mobile-backend.md) owns exact wire shapes and accepted token-binding limits. Tests linked by each flow use fictional providers; native-device, real Rita ID and TLS acceptance remain separate.
