import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { OAuthSessions, keyHash } from "../src/auth/oauth-sessions.js";
import { setTimeout as delay } from "node:timers/promises";
const config = readConfig({ RITA_CLIENT_ID: "client", RITA_CLIENT_SECRET: "secret" });
const profile = { sub: "12345678-1234-4123-8123-123456789012", name: "Test", email: "test@example.invalid", employee_id: null, phone_number: null, is_developer: false, groups: "EMPLOYEE" as const };
const authorization = () => ({ profile, expiresAt: Date.now() + 300_000, tokens: { accessToken: "private-access", refreshToken: "private-refresh", scopes: [] } });
const oauth = { exchange: async () => authorization(), verify: async () => authorization(), refresh: async () => authorization().tokens, revoke: async () => {} };
const cookie = (res: request.Response) => String(res.headers["set-cookie"]).split(";")[0]!;

test("bootstrap is token-free, directly bound to a hashed random cookie, and stable across reads", async () => {
  const sessions = new OAuthSessions(oauth);
  const created = sessions.create();
  assert.equal(created.key.length, 43);
  assert.ok(sessions.browser(keyHash(created.key)));
  assert.equal(sessions.browser(created.key), undefined);
  await sessions.close(created.id);
  const agent = request.agent(createApp(config, { oauth }));
  const first = await agent.get("/api/session").expect(200);
  assert.deepEqual(Object.keys(first.body).sort(), ["authenticated", "csrf", "session"]);
  assert.equal(first.body.authenticated, false);
  assert.match(cookie(first), /^rita_example\.key=[A-Za-z0-9_-]{43}$/);
  assert.equal(first.headers["cache-control"], "no-store");
  const second = await agent.get("/api/session").expect(200);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.headers["set-cookie"], undefined);
  assert.ok(!JSON.stringify(first.body).includes(cookie(first).split("=")[1]!));
});

test("invalid, duplicate, unknown and legacy cookies cannot authenticate; bootstrap recovers", async () => {
  const app = createApp(config, { oauth });
  for (const value of ["rita_example.key=bad", "rita_example.key=%not-encoded", `rita_example.key=${'x'.repeat(43)}`, "rita_example.sid=legacy", "rita_example.key=one; rita_example.key=two"]) {
    await request(app).get("/api/me").set("Cookie", value).expect(401);
    const bootstrap = await request(app).get("/api/session").set("Cookie", value).expect(200);
    assert.equal(bootstrap.body.authenticated, false);
  }
  const legacy = await request(app).get("/api/session").set("Cookie", "rita_example.sid=old");
  assert.match(String(legacy.headers["set-cookie"]), /rita_example.sid=;.*Expires=Thu, 01 Jan 1970/);
});

test("capacity rejects new sessions but permits rotating an existing session; anonymous TTL frees slots", async () => {
  let time = Date.now();
  const app = createApp({ ...config, maxSessionEntries: 1 }, { oauth, now: () => time });
  const agent = request.agent(app);
  await agent.get("/api/session").expect(200);
  await request(app).get("/api/session").expect(503, { error: "store_full" });
  const begin = await agent.get("/auth/login");
  const state = new URL(begin.headers.location!).searchParams.get("state");
  await agent.get("/auth/callback").query({ state, code: "code" }).expect(302);
  await agent.get("/api/me").expect(200);
  const csrf = (await agent.get("/api/session")).body.csrf;
  await agent.post("/auth/logout").send({ csrf }).expect(200);
  await agent.get("/api/session").expect(200);
  time += 600_001;
  // Trigger expiry without creating a replacement, then allow cleanup to finish.
  await agent.get("/api/me").expect(401);
  await request(app).get("/api/session").expect(200);
});

test("Origin, CSRF, parser limits and SPA routing are enforced", async () => {
  const app = createApp(config, { oauth });
  const agent = request.agent(app);
  const bootstrap = await agent.get("/api/session");
  const csrf = bootstrap.body.csrf;
  await agent.post("/auth/logout").set("Origin", "https://other.invalid").send({ csrf }).expect(403, { error: "invalid_origin" });
  await agent.post("/auth/logout").send({ csrf: "wrong" }).expect(403);
  await agent.post("/auth/refresh").type("json").send("{").expect(400, { error: "invalid_body" });
  await agent.post("/auth/refresh").send({ csrf: "x".repeat(5000) }).expect(413, { error: "body_too_large" });
  await agent.post("/auth/logout").set("Origin", config.appUrl).send({ csrf }).expect(200);
  await agent.post("/auth/logout").send({}).expect(200, { loggedOut: true, revokeConfirmed: true });
  await request(app).get("/example/deep-link").set("Accept", "text/html").expect(200).expect("Content-Type", /html/);
  for (const path of ["/api/missing", "/auth/missing", "/assets/missing.js", "/missing.js"]) await request(app).get(path).expect(404);
});

test("callback from another browser, duplicate cookie and stale CSRF cannot take over a login", async () => {
  const app = createApp(config, { oauth, callbackResponse: "json" });
  const agent = request.agent(app);
  const old = await agent.get("/api/session");
  const begin = await agent.get("/auth/login");
  const state = new URL(begin.headers.location!).searchParams.get("state");
  await request(app).get("/auth/callback").query({ state, code: "code" }).expect(400);
  await request(app).get("/auth/callback").set("Cookie", `${cookie(old)}; ${cookie(old)}`).query({ state, code: "code" }).expect(400);
  const completed = await agent.get("/auth/callback").query({ state, code: "code" }).expect(200);
  assert.notEqual(cookie(completed), cookie(old));
  await agent.post("/auth/refresh").send({ csrf: old.body.csrf }).expect(403);
  await request(app).get("/api/me").set("Cookie", cookie(old)).expect(401);
});

test("a new login cancels an in-flight callback and revokes its issued token", async () => {
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const revoked: string[] = [];
  const app = createApp(config, { oauth: { ...oauth, exchange: async () => { entered(); await blocked; return authorization(); }, revoke: async token => { revoked.push(token); } } });
  const agent = request.agent(app);
  const begin = await agent.get("/auth/login");
  const state = new URL(begin.headers.location!).searchParams.get("state");
  const callback = request(app).get("/auth/callback").set("Cookie", cookie(begin)).query({ state, code: "code" }).then(r => r);
  await started;
  await agent.get("/auth/login").expect(302);
  release();
  const result = await callback;
  assert.equal(result.headers.location, "/?auth=invalid_state");
  assert.equal(result.headers["set-cookie"], undefined);
  assert.deepEqual(revoked, ["private-refresh"]);
});

test("anonymous cleanup runs without a browser and never revokes a nonexistent token", async () => {
  let revoked = 0;
  const sessions = new OAuthSessions({ ...oauth, revoke: async () => { revoked++; } }, Date.now, 1);
  const old = sessions.create(undefined, Date.now() + 15);
  await delay(40);
  assert.equal(sessions.browser(old.id), undefined);
  const next = sessions.create();
  await sessions.close(next.id);
  assert.equal(revoked, 0);
});

test("an abandoned callback revokes the exchanged token instead of publishing a session", async t => {
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const revoked: string[] = [];
  const app = createApp(config, { oauth: { ...oauth, exchange: async () => { entered(); await blocked; return authorization(); }, revoke: async token => { revoked.push(token); } } });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const agent = request.agent(server);
  const begin = await agent.get("/auth/login");
  const state = new URL(begin.headers.location!).searchParams.get("state");
  const pending = request(server).get("/auth/callback").set("Cookie", cookie(begin)).query({ state, code: "code" });
  pending.end(() => undefined);
  await started;
  pending.abort();
  await delay(20);
  release();
  for (let tries = 0; tries < 50 && !revoked.length; tries++) await delay(10);
  assert.deepEqual(revoked, ["private-refresh"]);
  await agent.get("/api/session").expect(200).expect(r => assert.equal(r.body.authenticated, false));
});
