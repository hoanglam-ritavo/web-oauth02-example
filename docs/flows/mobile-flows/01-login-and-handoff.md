# Mobile login and handoff

[Flow index](../README.md) | [Deployment](../../deployment.md) | [HTTP contract](../../mobile-backend.md#http-contract)

## Participants and prerequisites

Native Mobile A, its system browser, Rita Portal/ID and application backend B participate. Enable mobile or both mode in B, provision the public client and match A's client ID and device-reachable B origin. The installed A scheme is `rita-id-app://redirect`. B does not receive that callback or exchange A's authorization code.

## Successful flow

1. A opens Rita Portal with PKCE S256/state, consumes its native callback and exchanges the code directly with Rita ID. This behavior belongs to the sibling A source.
2. A holds the token pair in RAM and POSTs handoffId/clientId/accessToken/refreshToken to B's `/api/mobile/auth/session` without a cookie or Bearer X.
3. B validates the request and configured client ID, reserves session/handoff capacity and binds the canonical payload with per-process HMAC fingerprints. Original refresh credentials cannot be consumed under another handoff ID.
4. B verifies the original RS256 JWT, purpose, audience, expiry, required scopes and userinfo identity. It then refreshes using the public client without client_secret.
5. B immediately retains replacement credentials and verifies the same subject/client/scope set. Only then does it establish a session and return X, absolute expiresAt and profile.
6. A stores X metadata in SecureStore, discards pending OAuth tokens and displays the verified identity. B owns future refresh/revoke.

## Retry, failures and concurrency

Identical concurrent requests share one operation. A mismatched payload or reuse of the original refresh credential under another ID returns 409. Success replay returns the same X/profile/deadline without a second rotation; AES-GCM protects replay JSON for 150 seconds from success. Expired replay becomes a bounded tombstone and cannot recreate a revoked session. Capacity returns 503 rather than evicting live entries.

At replay expiry the ciphertext is dropped; its fingerprint tombstone remains until the later of replay expiry or session expiry. Pending/failed records retain tombstones until the initial 150-second deadline plus the configured session lifetime. Original tokens are not retained for fingerprint matching; active replacement credentials still live in RAM, so encrypted replay does not imply complete process-memory protection.

A's manual retry window is 120 seconds; B's unfinished handoff deadline is 150 seconds. Before rotation, temporary verification failure can retry after a five-second cooldown. After rotation, retry verifies the retained replacement only. Explicit trusted pre-consumption `503 temporarily_unavailable` may retry; ambiguous token responses, timeout or lost response terminate the attempt instead of resubmitting a possibly consumed refresh token. Configuration failures return 502.

Late replacements after expiry are revoked best-effort and never publish X. Client disconnect does not cancel B's work because an identical retry can recover the response. If A never receives X, the orphaned session expires at its finite deadline. Process loss cannot guarantee upstream revocation.

Validation proves subject/client/scope consistency, not that the original pair came from one grant; Rita access tokens have no original-session linkage. See [accepted limit](../../mobile-backend.md#handoff-validation-and-accepted-limit).

## Implementation and evidence

[Mobile router](../../../src/mobile/routes.ts), [handoff manager](../../../src/mobile/mobile-sessions.ts) and [OAuth adapter](../../../src/auth/oauth-client.ts) implement B. [Mobile tests](../../../test/mobile.test.ts) cover replay, capacity, races and uncertainty; [HTTP tests](../../../test/mobile-http.test.ts) exercise fictional RSA/JWKS verification; [A adapter compatibility](../../../scripts/test-mobile-compat.mjs) uses A's real transport adapter. These do not execute native consent/callback or live Rita ID.
