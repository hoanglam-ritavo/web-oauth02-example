import { profileFields } from "./profile-fixture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRemoteJWKSet, generateKeyPair, SignJWT, exportJWK } from "jose";
import { createOAuthClient, InvalidIdentityError } from "../src/auth/oauth-client.js";
import { OAuthSessions, SessionError } from "../src/auth/oauth-sessions.js";
import { readConfig } from "../src/config.js";
const config = readConfig({ RITA_CLIENT_ID: "client", RITA_CLIENT_SECRET: "secret" });
const subject = "12345678-1234-4123-8123-123456789012";
const keys = await generateKeyPair("RS256");
const jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid: "key", alg: "RS256" }] };
const profile = { sub: subject, name: "Test", email: "", employee_id: null, phone_number: null, ...profileFields(), is_developer: false, groups: "EMPLOYEE" as const };
for (const mode of ["503", "429", "json", "schema", "timeout"]) {
  test(`JWKS ${mode} preserves credentials and recovers without refresh or revoke`, async t => {
    let broken = true, calls = 0, revoked = 0, refreshes = 0;
    let time = Date.now();
    const server = createServer((_req, res) => {
      calls++;
      if (broken && mode === "timeout") return;
      if (broken && ["503", "429"].includes(mode)) { res.writeHead(Number(mode)); res.end(); return; }
      res.setHeader("Content-Type", "application/json");
      res.end(broken ? mode === "json" ? "not json" : JSON.stringify({ keys: "invalid" }) : JSON.stringify(jwks));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    t.after(() => { server.closeAllConnections(); server.close(); });
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const key = createRemoteJWKSet(new URL(`http://127.0.0.1:${address.port}/jwks`), { timeoutDuration: 50, cooldownDuration: 0, cacheMaxAge: 600_000 });
    const accessToken = await new SignJWT({ sub: subject, token_use: "oauth_access" }).setProtectedHeader({ alg: "RS256", kid: "key" }).setAudience("client").setExpirationTime(Math.floor(time / 1000) + 300).sign(keys.privateKey);
    const oauth = createOAuthClient(config, { key, now: () => time, adapter: async () => ({ data: JSON.stringify({ ...profile, _id: subject }), status: 200, statusText: "OK", headers: {}, config: {} as never }) });
    const store = new OAuthSessions({ ...oauth, refresh: async () => { refreshes++; throw new Error("unexpected refresh"); }, revoke: async () => { revoked++; } }, () => time);
    const created = store.create({ profile, expiresAt: time + 300000, tokens: { accessToken, refreshToken: "private-refresh", scopes: [] } }, time + 600000);
    await assert.rejects(store.resolve(created.id), e => e instanceof SessionError && e.status === 503);
    assert.equal(revoked, 0); assert.equal(refreshes, 0);
    assert.equal((await store.status(created.id)).canRefresh, true);
    broken = false; time += 5000;
    assert.equal((await store.resolve(created.id)).profile.sub, subject);
    const afterRecovery = calls;
    await store.resolve(created.id);
    assert.equal(calls, afterRecovery); // cache hit
    assert.equal(refreshes, 0);
    await store.close(created.id);
  });
}
for (const token_use of [undefined, "sso_access", "id_token", "client_access"]) {
  test(`example rejects purpose ${token_use} even with a valid signature and audience`, async () => {
    const accessToken = await new SignJWT({ sub: subject, ...(token_use ? { token_use } : {}) }).setProtectedHeader({ alg: "RS256", kid: "key" }).setAudience("client").setExpirationTime("5m").sign(keys.privateKey);
    const oauth = createOAuthClient(config, { key: async () => keys.publicKey });
    await assert.rejects(oauth.verify({ accessToken, scopes: [] }), InvalidIdentityError);
  });
}
