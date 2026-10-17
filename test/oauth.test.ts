import request from "supertest";
import session from "express-session";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApp } from "../src/app.js";
﻿import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from "jose";
import { createOAuthClient } from "./provider-fixture.js";
import { readConfig } from "../src/config.js";

const config = readConfig({ RITA_CLIENT_ID: "client", RITA_CLIENT_SECRET: "secret", SESSION_SECRET: "x".repeat(32) });
const subject = "12345678-1234-4123-8123-123456789012";
const now = Math.floor(Date.now() / 1000);
const keys = await generateKeyPair("RS256");
const otherKeys = await generateKeyPair("RS256");
const key = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: "demo", alg: "RS256", use: "sig" }] });
async function token(options: { isClient?: boolean; alg?: string; noAud?: boolean; noSub?: boolean; aud?: string; exp?: number; sub?: string; wrongKey?: boolean; noExp?: boolean } = {}) {
  const signer = new SignJWT({ ...(options.noSub ? {} : { sub: options.sub ?? subject }), ...(options.isClient ? { isClient: true } : {}) })
    .setProtectedHeader({ alg: options.alg ?? "RS256", kid: "demo" }).setIssuedAt(now);
  if (!options.noAud) signer.setAudience(options.aud ?? "client");
  if (!options.noExp) signer.setExpirationTime(options.exp ?? now + 300);
  return signer.sign(options.alg === "HS256" ? new TextEncoder().encode("test-only-secret-at-least-32-characters") : options.wrongKey ? otherKeys.privateKey : keys.privateKey);
}
const userinfo = { _id: subject, name: "Demo", email: "demo@example.com", employee_id: null, phone_number: null, is_developer: false, groups: "EMPLOYEE" };
function mockFetch(accessToken: string, profile: unknown = userinfo) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return Response.json(String(input).endsWith("/token")
      ? { access_token: accessToken, token_type: "Bearer", id_token: "discard-id", refresh_token: "discard-refresh", expires_in: 300 }
      : profile);
  };
  return { fetcher, calls };
}

test("exchanges exact JSON contract then verifies RSA/JWKS and matches userinfo subject", async () => {
  const accessToken = await token();
  const { fetcher, calls } = mockFetch(accessToken, { ...userinfo, arbitrary: "not persisted" });
  const client = createOAuthClient(config, { fetch: fetcher, key, now: () => now * 1000 });
  const result = await client.exchange("code", "verifier");
  assert.deepEqual(result, { tokens: { accessToken, refreshToken: "discard-refresh", scopes: [] }, profile: { sub: subject, name: userinfo.name, email: userinfo.email, employee_id: null, phone_number: null, is_developer: false, groups: "EMPLOYEE" }, expiresAt: (now + 300) * 1000 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, config.apiUrl + "/auth/oauth/token");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    grant_type: "authorization_code", client_id: "client", client_secret: "secret",
    redirect_uri: config.callbackUrl, code: "code", code_verifier: "verifier",
  });
  assert.equal(calls[1]!.url, config.apiUrl + "/auth/oauth/userinfo");
  assert.equal(new Headers(calls[1]!.init.headers).get("Authorization"), "Bearer " + accessToken);
  assert.equal(calls[0]!.init.redirect, "error");
  assert.equal(calls[1]!.init.redirect, "error");
  assert.ok(calls[0]!.init.signal);
  assert.doesNotMatch(JSON.stringify(result.profile), /discard|access_token|arbitrary/);
});

test("exchanges through an API prefix including real remote JWKS verification", async (t) => {
  const accessToken = await token();
  const jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid: "demo", alg: "RS256", use: "sig" }] };
  const calls: { path: string; method: string; authorization?: string; contentType?: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    calls.push({ path: req.url!, method: req.method!, authorization: req.headers.authorization,
      contentType: req.headers["content-type"], body });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/auth/oauth/token") {
      res.end(JSON.stringify({ access_token: accessToken, token_type: "Bearer" }));
    } else if (req.url === "/api/.well-known/jwks.json") {
      res.end(JSON.stringify(jwks));
    } else if (req.url === "/api/auth/oauth/userinfo") {
      res.end(JSON.stringify(userinfo));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const proxyConfig = readConfig({
    RITA_CLIENT_ID: "client", RITA_CLIENT_SECRET: "secret", SESSION_SECRET: "x".repeat(32),
    RITA_API_URL: `http://127.0.0.1:${address.port}/api/`,
  });
  const result = await createOAuthClient(proxyConfig, { now: () => now * 1000 }).exchange("code", "verifier");
  assert.equal(result.profile.sub, subject);
  assert.deepEqual(calls.map(call => [call.method, call.path]), [
    ["POST", "/api/auth/oauth/token"],
    ["GET", "/api/.well-known/jwks.json"],
    ["GET", "/api/auth/oauth/userinfo"],
  ]);
  assert.equal(calls[0]!.contentType, "application/json");
  assert.deepEqual(JSON.parse(calls[0]!.body), {
    grant_type: "authorization_code", client_id: "client", client_secret: "secret",
    redirect_uri: proxyConfig.callbackUrl, code: "code", code_verifier: "verifier",
  });
  assert.equal(calls[2]!.authorization, "Bearer " + accessToken);
});

for (const [label, options] of Object.entries({
  "client token": { isClient: true }, "wrong algorithm": { alg: "HS256" },
  "missing audience": { noAud: true }, "missing subject": { noSub: true },
  "wrong signature": { wrongKey: true }, "wrong audience": { aud: "another-client" },
  "expired token": { exp: now - 1 }, "missing expiry": { noExp: true }, "invalid subject": { sub: "not-a-uuid" },
})) {
  test("rejects " + label + " before userinfo", async () => {
    const { fetcher, calls } = mockFetch(await token(options));
    await assert.rejects(createOAuthClient(config, { fetch: fetcher, key }).exchange("code", "verifier"));
    assert.equal(calls.length, 2); // Failed identity also revokes the issued refresh token.
  });
}
test("rejects mismatched userinfo subject and malformed profile", async () => {
  for (const profile of [null, { ...userinfo, _id: "other" }, { sub: subject },
    ...Object.keys(userinfo).map(field => ({ ...userinfo, [field]: undefined })),
    ...["name", "email", "employee_id", "phone_number", "is_developer", "groups"].map(field => ({ ...userinfo, [field]: 42 })),
    { ...userinfo, groups: "DEVELOPER" }, { ...userinfo, is_developer: "false" },
    { ...userinfo, _id: undefined, sub: subject }]) {
    const { fetcher } = mockFetch(await token(), profile);
    await assert.rejects(createOAuthClient(config, { fetch: fetcher, key }).exchange("code", "verifier"));
  }
});
for (const endpoint of ["token", "userinfo"]) {
  test(endpoint + " errors and timeout reject without retry", async () => {
    for (const failure of ["status", "timeout", "json"]) {
      const accessToken = await token();
      let count = 0;
      const fetcher: typeof fetch = async (input, init = {}) => {
        count++;
        if (String(input).endsWith("/" + endpoint)) {
          if (failure === "status") return new Response("private upstream error", { status: 500 });
          if (failure === "json") return new Response("not json");
          return new Promise<Response>((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("test timeout failed")), 1000);
            init.signal!.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(init.signal!.reason);
            }, { once: true });
          });
        }
        return Response.json({ access_token: accessToken, token_type: "Bearer" });
      };
      await assert.rejects(createOAuthClient(config, { fetch: fetcher, key, timeoutMs: 10 }).exchange("code", "verifier"));
      assert.equal(count, endpoint === "token" ? 1 : 2);
    }
  });
}
test("rejects malformed token response", async () => {
  for (const body of [null, {}, { access_token: 12 }, { access_token: "x", token_type: "Other" }]) {
    await assert.rejects(createOAuthClient(config, { fetch: async () => Response.json(body), key }).exchange("code", "verifier"));
  }
});



test("legacy issuer configuration is ignored", () => {
  const env = { RITA_CLIENT_ID: "client", RITA_CLIENT_SECRET: "secret", SESSION_SECRET: "x".repeat(32) };
  assert.deepEqual(readConfig({ ...env, RITA_ISSUER: "obsolete" }), readConfig(env));
});
test("supports all groups, developer booleans and nullable profile fields", async () => {
  for (const groups of ["EMPLOYEE", "CUSTOMER", "ENTERPRISE"]) {
    for (const is_developer of [false, true]) {
      const profile = { ...userinfo, groups, is_developer, employee_id: "E001", phone_number: "123" };
      const { fetcher } = mockFetch(await token(), profile);
      const result = await createOAuthClient(config, { fetch: fetcher, key }).exchange("code", "verifier");
      const { _id, ...fields } = profile;
      assert.deepEqual(result.profile, { sub: _id, ...fields });
    }
  }
});
test("rejects a token that expires while fetching userinfo", async () => {
  let time = now * 1000;
  const { fetcher } = mockFetch(await token());
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const response = await fetcher(input, init);
    if (String(input).endsWith("/userinfo")) time += 301_000;
    return response;
  };
  await assert.rejects(createOAuthClient(config, { fetch, key, now: () => time }).exchange("code", "verifier"));
});

test("real adapter keeps credentials outside Express session and revokes on logout", async (t) => {
  let time = now * 1000;
  const accessToken = await token();
  const { fetcher, calls } = mockFetch(accessToken);
  const saved: string[] = [];
  const originalSet = session.MemoryStore.prototype.set;
  t.mock.method(session.MemoryStore.prototype, "set", function (
    this: session.MemoryStore, ...args: Parameters<typeof originalSet>
  ) {
    saved.push(JSON.stringify(args[1]));
    return originalSet.apply(this, args);
  });
  const oauth = createOAuthClient(config, { fetch: fetcher, key, now: () => time });
  const app = createApp(config, { oauth, now: () => time });
  const agent = request.agent(app);
  const login = await agent.get("/auth/login").expect(302);
  const state = new URL(login.headers.location!).searchParams.get("state");
  await agent.get("/auth/callback").query({ state, code: "once" }).expect(302);
  const home = await agent.get("/").expect(200);
  assert.ok(home.text.includes('id="profile"'));
  assert.ok(!home.text.includes("demo@example.com"));
  const me = await agent.get("/api/me").expect(200);
  assert.equal(me.body.sub, subject);
  time += 200_000;
  await agent.get("/api/me").expect(200);
  assert.equal(calls.length, 4);
  const csrf = /name="csrf" value="([^"]+)"/.exec(home.text)![1]!;
  await agent.post("/auth/logout").type("form").send({ csrf }).expect(303);
  await agent.get("/api/me").expect(401, { error: "not_authenticated" });
  assert.equal(calls.length, 5);
  assert.ok(saved.some(value => value.includes('"oauthId"')));
  for (const value of [...saved, home.text, JSON.stringify(me.body)]) {
    assert.ok(!value.includes(accessToken));
    assert.doesNotMatch(value, /discard-id|discard-refresh|accessToken|refreshToken|id_token|client_secret/);
  }
});
