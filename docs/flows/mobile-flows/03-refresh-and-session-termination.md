# Mobile refresh and session termination

[Flow index](../README.md) | [Deployment](../../deployment.md) | [HTTP contract](../../mobile-backend.md#http-contract)

## Participants and prerequisites

B owns the accepted OAuth credentials and session X; A owns only its local X metadata. Rita ID handles refresh/revoke for the public mobile client. This flow requires mobile/both mode and an established B session.

## Refresh flow

1. A requests `/api/mobile/me` or a private resource with X; there is no manual mobile refresh endpoint.
2. When needed, B refreshes with RITA_MOBILE_CLIENT_ID and no confidential client secret. Concurrent requests share the in-flight operation.
3. B commits replacement credentials before verifying JWT/userinfo and the stable subject. Temporary verification failures keep that replacement for verification-only retry after cooldown.
4. X and its absolute deadline remain unchanged. A receives the normal endpoint response after successful verification.

Ambiguous refresh results end the session rather than replaying the old refresh token. Invalid grant or identity ends authentication; permission/configuration/temporary failures remain distinct. The shared lifecycle's version checks suppress late results from older credentials.

## Logout and expiry

1. A POSTs `/api/mobile/auth/logout` with Bearer X and no body.
2. B invalidates handoff replay, marks the session closing before awaiting work and waits for an active refresh so the latest known refresh credential is revoked.
3. B removes local state even when revoke fails and returns loggedOut=true with revokeConfirmed indicating the upstream result. Missing/expired X returns 401, which A treats as already unusable.
4. A clears local storage; false/unconfirmed revocation is reported separately. Late responses cannot restore its logged-out identity.

Timers expire sessions and replay/tombstone records without sliding the session deadline. B restart loses all RAM state and cannot guarantee revoke; fresh login is required. Neither app logout nor OAuth revoke removes Rita's browser SSO cookie, and issued access JWTs may remain valid until expiry. Local deletion and provider revocation are separate outcomes.

## Implementation and evidence

[Mobile session manager](../../../src/mobile/mobile-sessions.ts) coordinates replay and close; [OAuthSessions](../../../src/auth/oauth-sessions.ts) owns rotation/version/closing behavior; [router](../../../src/mobile/routes.ts) defines logout response semantics. [Mobile regressions](../../../test/mobile.test.ts), [lifecycle tests](../../../test/lifecycle.test.ts) and [HTTP tests](../../../test/mobile-http.test.ts) cover expiry, single-flight refresh, revoke failure and late replacement cleanup. [Compatibility](../../../scripts/test-mobile-compat.mjs) checks A adapter logout against fictional HTTP services, not installed-device cleanup.
