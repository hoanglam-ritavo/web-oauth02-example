import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import request from "supertest";
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from "jose";
import { createApp } from "../src/app.js";
import { createOAuthClient } from "./provider-fixture.js";
import { readConfig } from "../src/config.js";

const keys = await generateKeyPair("RS256");
const key = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: "demo", alg: "RS256" }] });
const subject = "12345678-1234-4123-8123-123456789012";
const otherSubject = "22345678-1234-4123-8123-123456789012";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(options: { refresh?: boolean; lifetime?: number } = {}) {
  let time = Math.floor(Date.now() / 1000) * 1000;
  const config = readConfig({
    RITA_CLIENT_ID: "fixture-client", RITA_CLIENT_SECRET: "fixture-client-secret",
    SESSION_SECRET: "s".repeat(40),
  });
  if (options.lifetime !== undefined) config.sessionMaxAgeMs = options.lifetime;
  const state = {
    refreshes: 0, exchanges: 0, userinfos: 0, currentRefresh: "", sequence: 0,
    subject, name: "Demo Employee", revoked: [] as string[], issued: [] as string[],
    calls: [] as { path: string; body?: Record<string, string> }[],
    beforeRefresh: undefined as undefined | (() => Promise<Response | void>),
    afterRefresh: undefined as undefined | (() => Promise<Response | void>),
    beforeExchange: undefined as undefined | (() => Promise<void>),
    beforeUserinfo: undefined as undefined | (() => Promise<Response | void>),
    revokeFails: false,
  };
  async function issue() {
    const accessToken = await new SignJWT({ token_use: "oauth_access", sub: state.subject })
      .setProtectedHeader({ alg: "RS256", kid: "demo" }).setAudience(config.clientId)
      .setExpirationTime(Math.floor(time / 1000) + 300).sign(keys.privateKey);
    state.currentRefresh = "fixture-refresh-" + ++state.sequence;
    state.issued.push(accessToken, state.currentRefresh);
    return Response.json({
      access_token: accessToken, token_type: "Bearer", scope: "openid profile email",
      ...(options.refresh === false ? {} : { refresh_token: state.currentRefresh }),
      id_token: "fixture-id-token",
    });
  }
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : undefined;
    state.calls.push({ path, body });
    if (path.endsWith("/token")) {
      assert.equal(body?.client_id, config.clientId);
      assert.equal(body?.client_secret, config.clientSecret);
      if (body?.grant_type === "authorization_code") {
        state.exchanges++;
        await state.beforeExchange?.();
        return issue();
      }
      assert.equal(body?.grant_type, "refresh_token");
      assert.equal(body?.scope, undefined);
      state.refreshes++;
      const override = await state.beforeRefresh?.();
      if (override) return override;
      if (body.refresh_token !== state.currentRefresh) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      const response = await issue(); // Simulate committed rotation.
      return await state.afterRefresh?.() || response;
    }
    if (path.endsWith("/revoke")) {
      assert.equal(body?.client_id, config.clientId);
      assert.equal(body?.client_secret, config.clientSecret);
      state.revoked.push(body!.token!);
      return state.revokeFails ? new Response("", { status: 500 }) : new Response(null, { status: 200 });
    }
    assert.ok(path.endsWith("/userinfo"));
    state.userinfos++;
    const override = await state.beforeUserinfo?.();
    if (override) return override;
    return Response.json({
      _id: state.subject, name: state.name, email: "fixture-private@example.com",
      employee_id: "fixture-employee", phone_number: "fixture-private-phone",
      is_developer: false, groups: "EMPLOYEE",
    });
  };
  const oauth = createOAuthClient(config, { fetch: fetcher, key, now: () => time });
  const app = createApp(config, { oauth, now: () => time });
  const agent = request.agent(app);
  const begin = async () => {
    const response = await agent.get("/auth/login").expect(302);
    return new URL(response.headers.location!).searchParams.get("state")!;
  };
  const login = async () => {
    const pending = await begin();
    const response = await agent.get("/auth/callback").query({ state: pending, code: "fixture-code" }).expect(302);
    const home = await agent.get("/").expect(200);
    const csrf = (await agent.get("/api/session")).body.csrf;
    return { csrf, cookie: String(response.headers["set-cookie"]).split(";")[0]!, home: home.text };
  };
  return { config, state, app, agent, begin, login, advance: (ms: number) => { time += ms; }, time: () => time };
}

test("automatic refresh extends access but not local deadline and updates profile", async () => {
  const f = fixture();
  await f.login();
  const before = (await f.agent.get("/api/session").expect(200)).body.session;
  f.advance(300_000);
  f.state.name = "Updated Employee";
  await f.agent.get("/api/me").expect(200).expect(r => assert.equal(r.body.name, "Updated Employee"));
  const after = (await f.agent.get("/api/session").expect(200)).body.session;
  assert.equal(f.state.refreshes, 1);
  assert.equal(after.refreshCount, 1);
  assert.equal(after.lastRefreshAt, f.time());
  assert.equal(after.sessionExpiresAt, before.sessionExpiresAt);
  assert.ok(after.accessExpiresAt > before.accessExpiresAt);
  assert.deepEqual(after.scopes, ["openid", "profile", "email"]);
});

test("every private request fetches fresh profile without early rotation or cookie replacement", async () => {
  const f = fixture();
  await f.login();
  const initial = f.state.userinfos;
  f.state.name = "First profile";
  await f.agent.get("/api/me").expect(200).expect(r => assert.equal(r.body.name, "First profile"));
  f.state.name = "New profile";
  f.advance(280_000);
  const response = await f.agent.get("/api/me").expect(200);
  assert.equal(response.body.name, "New profile");
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(f.state.userinfos, initial + 2);
  assert.equal(f.state.refreshes, 0);
  await f.agent.get("/api/private/example").expect(200).expect(r => assert.equal(r.body.subject, subject));
  assert.equal(f.state.userinfos, initial + 3);
});

test("JSON refresh and logout retain the cookie until logout, require CSRF and expose no tokens", async () => {
  const f = fixture();
  const { csrf, cookie } = await f.login();
  await f.agent.post("/auth/refresh").set("Accept", "application/json").send({}).expect(403);
  const refreshed = await f.agent.post("/auth/refresh").set("Accept", "application/json").send({ csrf }).expect(200);
  assert.equal(refreshed.body.profile.sub, subject);
  assert.equal(refreshed.body.session.refreshCount, 1);
  assert.equal(refreshed.headers["set-cookie"], undefined);
  for (const token of f.state.issued) assert.ok(!JSON.stringify(refreshed.body).includes(token));
  const logout = await f.agent.post("/auth/logout").set("Accept", "application/json").send({ csrf })
    .expect(200, { loggedOut: true, revokeConfirmed: true });
  assert.match(String(logout.headers["set-cookie"]), /Expires=Thu, 01 Jan 1970/);
  await request(f.app).get("/api/private/example").set("Cookie", cookie).expect(401);
});

test("userinfo rejection with unexpired JWT never refreshes and clears the browser session", async () => {
  const f = fixture();
  await f.login();
  f.state.beforeUserinfo = async () => new Response(null, { status: 401 });
  const response = await f.agent.get("/api/private/example").expect(401);
  assert.equal(response.headers["set-cookie"], undefined); // Late reads must not erase a newer cookie.
  assert.equal(f.state.refreshes, 0);
  await f.agent.get("/api/session").expect(200).expect(r => assert.equal(r.body.authenticated, false));
});

test("userinfo 403 denies the resource without refresh or destroying the session", async () => {
  const f = fixture();
  await f.login();
  f.state.beforeUserinfo = async () => new Response(null, { status: 403 });
  await f.agent.get("/api/private/example").expect(403, { error: "forbidden" });
  await f.agent.get("/api/session").expect(200);
  assert.equal(f.state.refreshes, 0);
  f.state.beforeUserinfo = undefined;
  await f.agent.get("/api/me").expect(200);
});

test("userinfo outage without rotation preserves session and recovers after cooldown", async () => {
  const f = fixture();
  await f.login();
  f.state.beforeUserinfo = async () => new Response(null, { status: 503 });
  await f.agent.get("/api/me").expect(503).expect("Retry-After", "5");
  await f.agent.get("/api/session").expect(200);
  f.state.beforeUserinfo = undefined;
  f.advance(5_000);
  await f.agent.get("/api/me").expect(200);
  assert.equal(f.state.refreshes, 0);
});

test("expiry during userinfo refreshes once before the private handler", async () => {
  const f = fixture();
  await f.login();
  f.state.beforeUserinfo = async () => {
    f.state.beforeUserinfo = undefined;
    f.advance(300_000);
    return new Response(null, { status: 401 });
  };
  const response = await f.agent.get("/api/private/example").expect(200);
  assert.equal(response.body.subject, subject);
  assert.equal(f.state.refreshes, 1);
});

test("late failure from an old token cannot invalidate a concurrently refreshed session", async () => {
  const f = fixture();
  const { csrf, cookie } = await f.login();
  const started = deferred(), release = deferred();
  f.state.beforeUserinfo = async () => {
    f.state.beforeUserinfo = undefined;
    started.resolve(); await release.promise;
    return new Response(null, { status: 401 });
  };
  const oldRequest = request(f.app).get("/api/me").set("Cookie", cookie).then(r => r);
  await started.promise;
  await f.agent.post("/auth/refresh").set("Accept", "application/json").send({ csrf }).expect(200);
  release.resolve();
  assert.equal((await oldRequest).status, 200);
  assert.equal(f.state.refreshes, 1);
  await f.agent.get("/api/me").expect(200);
});

test("manual refresh requires CSRF, rotates every deliberate request and never calls direct auth refresh", async () => {
  const f = fixture();
  const { csrf } = await f.login();
  await f.agent.post("/auth/refresh").expect(403);
  await f.agent.post("/auth/refresh").type("form").send({ csrf: "bad" }).expect(403);
  assert.equal(f.state.refreshes, 0);
  const previous = f.state.currentRefresh;
  await f.agent.post("/auth/refresh").type("form").send({ csrf }).expect(200);
  assert.notEqual(f.state.currentRefresh, previous);
  await f.agent.post("/auth/refresh").type("form").send({ csrf }).expect(200);
  assert.equal(f.state.refreshes, 2);
  assert.ok(f.state.calls.every(c => !c.path.endsWith("/auth/refresh")));
});

test("concurrent automatic and manual requests share one rotation", async () => {
  const f = fixture();
  const { csrf, cookie } = await f.login();
  f.advance(300_000);
  const entered = deferred(), release = deferred();
  f.state.beforeRefresh = async () => { entered.resolve(); await release.promise; };
  const first = request(f.app).get("/api/me").set("Cookie", cookie).then(r => r);
  await entered.promise;
  const others = [
    request(f.app).get("/api/me").set("Cookie", cookie).then(r => r),
    request(f.app).post("/auth/refresh").set("Cookie", cookie).type("form").send({ csrf }).then(r => r),
  ];
  await delay(30);
  release.resolve();
  const results = await Promise.all([first, ...others]);
  assert.deepEqual(results.map(r => r.status), [200, 200, 200]);
  assert.equal(f.state.refreshes, 1);
  f.state.beforeRefresh = undefined;
  await f.agent.post("/auth/refresh").type("form").send({ csrf }).expect(200);
  assert.equal(f.state.refreshes, 2); // Uses replacement, never a stale SPA metadata copy.
});

test("HRM 503 keeps refresh token, imposes cooldown and safely retries", async () => {
  const f = fixture();
  await f.login();
  const previous = f.state.currentRefresh;
  f.advance(300_000);
  f.state.beforeRefresh = async () => Response.json({ error: "temporarily_unavailable", error_description: "private" }, { status: 503 });
  await f.agent.get("/api/me").expect(503, { error: "temporarily_unavailable" }).expect("Retry-After", "5");
  await f.agent.get("/api/me").expect(503);
  assert.equal(f.state.refreshes, 1);
  assert.equal(f.state.revoked.length, 0);
  assert.equal(f.state.currentRefresh, previous);
  f.advance(5_000);
  f.state.beforeRefresh = undefined;
  await f.agent.get("/api/me").expect(200);
  assert.equal(f.state.refreshes, 2);
});

test("userinfo outage after rotation retries the NEW access token without rotating again", async () => {
  const f = fixture();
  await f.login();
  f.advance(300_000);
  f.state.beforeUserinfo = async () => new Response("private upstream detail", { status: 503 });
  await f.agent.get("/api/me").expect(503);
  const status = (await f.agent.get("/api/session").expect(200)).body.session;
  assert.equal(status.verificationPending, true);
  assert.equal(status.refreshCount, 0);
  await f.agent.get("/api/me").expect(503);
  assert.equal(f.state.refreshes, 1);
  f.advance(5_000);
  f.state.beforeUserinfo = undefined;
  await f.agent.get("/api/me").expect(200);
  assert.equal(f.state.refreshes, 1);
  assert.equal((await f.agent.get("/api/session")).body.session.refreshCount, 1);
});

for (const failure of ["timeout", "lost-response", "malformed-json", "missing-replacement", "server-error"]) {
  test("ambiguous refresh " + failure + " ends local session without replay", async () => {
    const f = fixture();
    await f.login();
    const previous = f.state.currentRefresh;
    f.advance(300_000);
    f.state.afterRefresh = async () => {
      if (failure === "timeout") throw new DOMException("private timeout", "TimeoutError");
      if (failure === "lost-response") throw new TypeError("private network detail");
      if (failure === "malformed-json") return new Response("bad-json");
      if (failure === "missing-replacement") return Response.json({ access_token: "x", token_type: "Bearer" });
      return Response.json({ error: "unknown" }, { status: 500 });
    };
    await f.agent.get("/api/me").expect(401, { error: "not_authenticated" });
    await f.agent.get("/api/me").expect(401);
    assert.equal(f.state.refreshes, 1);
    assert.deepEqual(f.state.revoked, [previous]); // Backend can revoke via token history.
  });
}
test("invalid_grant ends session; configuration errors remain explicit without redirect loops", async () => {
  for (const code of ["invalid_grant", "invalid_client", "invalid_scope", "unauthorized_client"]) {
    const f = fixture();
    await f.login();
    f.advance(300_000);
    f.state.beforeRefresh = async () => Response.json({ error: code, error_description: "private provider message" }, { status: code === "invalid_client" ? 401 : 400 });
    const status = code === "invalid_grant" ? 401 : 502;
    await f.agent.get("/api/me").expect(status, { error: code === "invalid_grant" ? "not_authenticated" : "integration_error" });
    await f.agent.get("/api/me").expect(status);
    assert.equal(f.state.refreshes, 1);
    if (status === 502) await f.agent.get("/api/session").expect(502).expect(r => assert.equal(r.headers.location, undefined));
  }
});

test("refresh refuses changed JWT subject and revokes replacement", async () => {
  const f = fixture();
  await f.login();
  f.advance(300_000);
  f.state.subject = otherSubject;
  await f.agent.get("/api/me").expect(401);
  assert.deepEqual(f.state.revoked, [f.state.currentRefresh]);
  assert.equal(f.state.userinfos, 1); // Rejected before querying userinfo.
});

test("refresh refuses mismatched userinfo and revokes replacement", async () => {
  const f = fixture();
  await f.login();
  f.advance(300_000);
  f.state.beforeUserinfo = async () => Response.json({ _id: otherSubject });
  await f.agent.get("/api/me").expect(401);
  assert.deepEqual(f.state.revoked, [f.state.currentRefresh]);
});

test("without refresh token expiry requires login and UI explains the limitation", async () => {
  const f = fixture({ refresh: false });
  const { csrf, home } = await f.login();
  assert.match(home, /No refresh token/);
  assert.equal((await f.agent.get("/api/session").expect(200)).body.session.canRefresh, false);
  await f.agent.post("/auth/refresh").type("form").send({ csrf }).expect(409);
  f.advance(300_001);
  await f.agent.get("/api/me").expect(401);
  assert.equal(f.state.refreshes, 0);
});

test("absolute local expiry revokes current token even when it can refresh", async () => {
  const f = fixture({ lifetime: 600_000 });
  await f.login();
  f.advance(300_000);
  await f.agent.get("/api/me").expect(200);
  const current = f.state.currentRefresh;
  f.advance(320_001);
  await f.agent.get("/api/me").expect(401);
  assert.deepEqual(f.state.revoked, [current]);
});

test("logout waits for refresh and revokes latest token; old cookie cannot restore session", async () => {
  const f = fixture();
  const { cookie, csrf } = await f.login();
  f.advance(300_000);
  const entered = deferred(), release = deferred();
  f.state.beforeRefresh = async () => { entered.resolve(); await release.promise; };
  const refresh = request(f.app).get("/api/me").set("Cookie", cookie).then(r => r);
  await entered.promise;
  const logout = request(f.app).post("/auth/logout").set("Cookie", cookie).type("form").send({ csrf }).then(r => r);
  await delay(30);
  release.resolve();
  assert.equal((await refresh).status, 401);
  assert.equal((await logout).status, 200);
  assert.deepEqual(f.state.revoked, [f.state.currentRefresh]);
  await request(f.app).get("/api/me").set("Cookie", cookie).expect(401);
});

test("logout failure clears local identity and reports unconfirmed revocation", async () => {
  const f = fixture();
  const { csrf, cookie } = await f.login();
  f.state.revokeFails = true;
  await f.agent.post("/auth/logout").type("form").send({ csrf }).expect(200, { loggedOut: true, revokeConfirmed: false });
  await request(f.app).get("/api/me").set("Cookie", cookie).expect(401);
});

test("logout cancels a callback already exchanging its code", async () => {
  const f = fixture();
  const { csrf } = await f.login();
  const state = await f.begin();
  const entered = deferred(), release = deferred();
  f.state.beforeExchange = async () => { entered.resolve(); await release.promise; };
  const callback = f.agent.get("/auth/callback").query({ state, code: "late-code" }).then(r => r);
  await entered.promise;
  await f.agent.post("/auth/logout").type("form").send({ csrf }).expect(200);
  release.resolve();
  assert.equal((await callback).status, 303);
  await f.agent.get("/api/me").expect(401);
  assert.equal(f.state.revoked.length, 2); // Old session and the canceled exchange.
});

test("successful re-login revokes previous OAuth session and restart loses local identity", async () => {
  const f = fixture();
  await f.login();
  const previous = f.state.currentRefresh;
  const { cookie } = await f.login();
  assert.deepEqual(f.state.revoked, [previous]);
  const restarted = createApp(f.config);
  await request(restarted).get("/api/me").set("Cookie", cookie).expect(401);
});

test("credentials and private profile never reach logs, cookies, or SPA metadata", async t => {
  const logs: unknown[][] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
  const saved: string[] = [];
  const f = fixture();
  const { csrf, cookie, home } = await f.login();
  await f.agent.post("/auth/refresh").type("form").send({ csrf }).expect(200);
  const me = await f.agent.get("/api/me").expect(200);
  const status = await f.agent.get("/api/session").expect(200);
  assert.deepEqual(Object.keys(status.body.session).sort(), ["accessExpiresAt", "sessionExpiresAt", "canRefresh", "scopes", "refreshCount", "lastRefreshAt", "verificationPending"].sort());
  await f.agent.post("/auth/logout").type("form").send({ csrf }).expect(200);
  const exposed = JSON.stringify([logs, saved, cookie, home, me.body, status.body]);
  for (const secret of [...f.state.issued, f.config.clientSecret, "fixture-id-token"]) {
    assert.ok(!exposed.includes(secret), "No credential exposure");
  }
  const privateStorage = JSON.stringify([logs, saved, cookie]);
  assert.doesNotMatch(privateStorage, /fixture-private|Demo Employee|fixture-employee/);
});

test("logout after failed refresh verification revokes replacement even before retry", async () => {
  const f = fixture();
  const { csrf } = await f.login();
  f.advance(300_000);
  f.state.beforeUserinfo = async () => new Response("", { status: 503 });
  await f.agent.get("/api/me").expect(503);
  await f.agent.post("/auth/logout").type("form").send({ csrf }).expect(200);
  assert.deepEqual(f.state.revoked, [f.state.currentRefresh]);
  assert.equal(f.state.refreshes, 1);
});

test("expired replacement during verification recovery ends session without another rotation", async () => {
  const f = fixture();
  await f.login();
  f.advance(300_000);
  f.state.beforeUserinfo = async () => new Response("", { status: 503 });
  await f.agent.get("/api/me").expect(503);
  f.advance(301_000);
  f.state.beforeUserinfo = undefined;
  await f.agent.get("/api/me").expect(401);
  assert.equal(f.state.refreshes, 1);
  assert.deepEqual(f.state.revoked, [f.state.currentRefresh]);
});

test("failed refresh destroys the local session even if revoke fails", async () => {
  const f = fixture();
  const { csrf } = await f.login();
  f.advance(300_000);
  f.state.beforeRefresh = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
  f.state.revokeFails = true;
  await f.agent.get("/api/me").expect(401);
  await f.agent.post("/auth/logout").type("form").send({ csrf }).expect(200);
  await f.agent.get("/api/session").expect(200).expect(r => assert.equal(r.body.authenticated, false));
});

test("idle expiry cleanup revokes without a browser request", async () => {
  const { OAuthSessions } = await import("../src/auth/oauth-sessions.js");
  const revoked = deferred();
  const sessions = new OAuthSessions({
    async exchange(): Promise<never> { throw new Error("unused"); },
    async refresh(): Promise<never> { throw new Error("unused"); },
    async verify(): Promise<never> { throw new Error("unused"); },
    async revoke(token) { assert.equal(token, "idle-refresh"); revoked.resolve(); },
  });
  sessions.add("idle-id", {
    profile: { sub: subject, name: "Demo", email: "", employee_id: null, phone_number: null, is_developer: false, groups: "EMPLOYEE" },
    expiresAt: Date.now() + 300_000,
    tokens: { accessToken: "idle-access", refreshToken: "idle-refresh", scopes: [] },
  }, Date.now() + 25);
  // Keep the test alive while the store's unref'ed cleanup timer runs.
  await Promise.race([revoked.promise, delay(1000).then(() => { throw new Error("Cleanup did not run"); })]);
  await assert.rejects(sessions.resolve("idle-id"));
});

test("callback reports confidential client configuration errors explicitly", async () => {
  const f = fixture();
  const oauth = createOAuthClient(f.config, {
    fetch: async () => Response.json({ error: "invalid_client", error_description: "private-secret" }, { status: 401 }),
    key,
  });
  const agent = request.agent(createApp(f.config, { oauth, callbackResponse: "json" }));
  const login = await agent.get("/auth/login").expect(302);
  const state = new URL(login.headers.location!).searchParams.get("state");
  await agent.get("/auth/callback").query({ state, code: "code" })
    .expect(502, { error: "integration_error" });
});
