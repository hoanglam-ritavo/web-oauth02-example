import { profileFields } from "./profile-fixture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";

const config = readConfig({
  RITA_CLIENT_ID: "demo-client", RITA_CLIENT_SECRET: "demo-secret",
  SESSION_SECRET: "a".repeat(40),
});
const unusedOAuth = {
  async refresh(): Promise<never> { throw new Error("Unexpected refresh"); },
  async verify() { return { profile, expiresAt: Date.now() + 120_000 }; },
  async revoke() {},
};
const sub = "12345678-1234-4123-8123-123456789012";
const profile = { sub, name: "Demo", email: "demo@example.com", employee_id: null, phone_number: null, ...profileFields(), is_developer: false, groups: "EMPLOYEE" as const };

test("static SPA shell and same-origin assets use CSP", async () => {
  const app = createApp(config);
  const home = await request(app).get("/").expect(200);
  assert.match(home.headers["content-security-policy"]!, /script-src 'self'/);
  assert.doesNotMatch(home.text, /demo-secret|fixture-access/);
  for (const path of ["app.js", "app.css", "axios.min.js"]) await request(app).get("/assets/" + path).expect(200);
});

test("strategy JSON callback establishes a session usable by RitaAuthGuard", async () => {
  const time = Date.now();
  let exchanges = 0;
  const app = createApp(config, { callbackResponse: "json", now: () => time,
    oauth: { ...unusedOAuth, async exchange() {
      exchanges++;
      return { tokens: { accessToken: "fixture-access", scopes: [] }, profile, expiresAt: time + 600_000 };
    } },
  });
  const agent = request.agent(app);
  const { response: login, url } = await begin(agent);
  const state = url.searchParams.get("state");
  const callback = await agent.get("/auth/callback").query({ state, code: "once" })
    .expect(200, { profile, expiresAt: time + 600_000 });
  assert.match(callback.headers["content-type"]!, /application\/json/);
  assert.equal(callback.headers["cache-control"], "no-store");
  assert.notEqual(String(callback.headers["set-cookie"]).split(";")[0],
    String(login.headers["set-cookie"]).split(";")[0]);
  await agent.get("/api/me").expect(200, profile);
  await agent.get("/auth/callback").query({ state, code: "once" })
    .expect(400, { error: "invalid_state" });
  assert.equal(exchanges, 1);
});

test("strategy JSON callback reports safe failures and never authenticates them", async () => {
  let exchanges = 0;
  const app = createApp(config, { callbackResponse: "json", oauth: { ...unusedOAuth, async exchange() {
    exchanges++;
    throw new Error("private-token-secret");
  } } });
  const agent = request.agent(app);
  await agent.get("/auth/callback?code=x").expect(400, { error: "invalid_state" });
  for (const scenario of [
    { query: { error: "access_denied" }, status: 400, error: "access_denied" },
    { query: {}, status: 400, error: "missing_code" },
    { query: { code: "x" }, status: 502, error: "authentication_failed" },
  ]) {
    const { url } = await begin(agent);
    await agent.get("/auth/callback").query({ state: url.searchParams.get("state"), ...scenario.query })
      .expect(scenario.status, { error: scenario.error });
    await agent.get("/api/me").expect(401);
  }
  assert.equal(exchanges, 1);
});

test("starting another login and denying consent preserves the active identity", async () => {
  const { agent, calls } = setup();
  const first = (await begin(agent)).url.searchParams.get("state");
  await agent.get("/auth/callback").query({ state: first, code: "once" }).expect(302);
  const before = await agent.get("/api/me").expect(200);
  const second = (await begin(agent)).url.searchParams.get("state");
  await agent.get("/api/me").expect(200, before.body);
  await agent.get("/auth/callback").query({ state: second, error: "access_denied" }).expect(303);
  await agent.get("/api/me").expect(200, before.body);
  assert.equal(calls.length, 1);
});
function setup() {
  let time = Date.now();
  const calls: { code: string; verifier: string }[] = [];
  const app = createApp(config, { now: () => time, oauth: { ...unusedOAuth, async exchange(code, verifier) {
    calls.push({ code, verifier });
    return { tokens: { accessToken: "fixture-access", scopes: [] }, profile: { ...profile, name: '<script>alert("x")</script>', email: "demo@example.com" }, expiresAt: time + 120_000 };
  } } });
  return { app, agent: request.agent(app), calls, advance: (ms: number) => { time += ms; } };
}
async function begin(agent: ReturnType<typeof request.agent>) {
  const response = await agent.get("/auth/login").expect(302);
  return { response, url: new URL(response.headers.location!) };
}

test("login builds PKCE redirect, callback rotates session and renders a token-free SPA shell", async () => {
  const { agent, calls } = setup();
  const { response, url } = await begin(agent);
  assert.equal(url.origin, config.portalUrl);
  assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("redirect_uri"), config.callbackUrl);
  assert.equal(url.searchParams.get("client_id"), config.clientId);
  assert.equal(url.searchParams.get("scope"), "openid profile email");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.has("prompt"), false);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("state")!.length >= 43);
  assert.ok(!url.toString().includes(config.clientSecret));
  const cookie = String(response.headers["set-cookie"]);
  assert.match(cookie, /rita_example\.key=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /Domain=|Secure/);
  const callback = await agent.get("/auth/callback").query({ state: url.searchParams.get("state"), code: "once" }).expect(302);
  assert.equal(callback.headers.location, "/?auth=success");
  assert.notEqual(String(callback.headers["set-cookie"]).split(";")[0], cookie.split(";")[0]);
  assert.equal(createHash("sha256").update(calls[0]!.verifier).digest("base64url"), url.searchParams.get("code_challenge"));
  const me = await agent.get("/api/me").expect(200);
  assert.equal(me.body.sub, sub);
  assert.equal(me.headers["cache-control"], "no-store");
  assert.doesNotMatch(JSON.stringify(me.body), /access_token|refresh_token|id_token|client_secret/);
  const home = await agent.get("/").expect(200);
  assert.match(home.text, /id="profile"/);
  assert.doesNotMatch(home.text, /alert/);
  assert.doesNotMatch(home.text, /<script>/);
  await agent.get("/auth/callback").query({ state: url.searchParams.get("state"), code: "once" }).expect(303);
  assert.equal(calls.length, 1);
});

test("missing, mismatched, duplicate, expired or superseded state never reaches token exchange", async () => {
  const { agent, calls, advance } = setup();
  const first = (await begin(agent)).url.searchParams.get("state")!;
  await agent.get("/auth/callback?code=x").expect(303);
  await agent.get("/auth/callback").query({ state: "bad", code: "x" }).expect(303);
  await agent.get("/auth/callback").query({ state: [first, first], code: "x" }).expect(303);
  const second = (await begin(agent)).url.searchParams.get("state")!;
  await agent.get("/auth/callback").query({ state: first, code: "x" }).expect(303);
  advance(600_001);
  await agent.get("/auth/callback").query({ state: second, code: "x" }).expect(303);
  await agent.get("/api/me").expect(401, { error: "not_authenticated" });
  assert.equal(calls.length, 0);
});

test("denial validates and consumes state, missing code consumes the attempt", async () => {
  const { agent, calls } = setup();
  let state = (await begin(agent)).url.searchParams.get("state")!;
  await agent.get("/auth/callback").query({ error: "access_denied", state: "wrong" }).expect(303);
  await agent.get("/auth/callback").query({ error: "access_denied", state }).expect(303);
  await agent.get("/auth/callback").query({ code: "x", state }).expect(303);
  state = (await begin(agent)).url.searchParams.get("state")!;
  await agent.get("/auth/callback").query({ state }).expect(303);
  await agent.get("/auth/callback").query({ state, code: "x" }).expect(303);
  assert.equal(calls.length, 0);
});

test("parallel callbacks exchange the code only once", async () => {
  const { app, agent, calls } = setup();
  const { response, url } = await begin(agent);
  const cookie = String(response.headers["set-cookie"]).split(";")[0]!;
  const results = await Promise.all([1, 2].map(() => request(app).get("/auth/callback")
    .set("Cookie", cookie).query({ state: url.searchParams.get("state"), code: "x" })));
  assert.deepEqual(results.map(r => r.status).sort(), [302, 303]);
  assert.equal(calls.length, 1);
});

test("pending claims are isolated between app instances", async () => {
  const first = setup();
  const second = setup();
  const firstState = (await begin(first.agent)).url.searchParams.get("state");
  // A shared map would let the second app's prune remove the first app's claim.
  // The first app's own clock and session are still within their login window.
  second.advance(20 * 60_000);
  const secondState = (await begin(second.agent)).url.searchParams.get("state");

  await second.agent.get("/auth/callback").query({ state: secondState, code: "second" }).expect(302);
  await first.agent.get("/auth/callback").query({ state: firstState, code: "first" }).expect(302);
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1);
  assert.equal(first.calls[0]!.code, "first");
  assert.equal(second.calls[0]!.code, "second");
});

test("session expires at token expiry, restart loses session, logout requires CSRF", async () => {
  const { app, agent, advance } = setup();
  const state = (await begin(agent)).url.searchParams.get("state");
  const login = await agent.get("/auth/callback").query({ state, code: "x" }).expect(302);
  const restarted = createApp(config);
  await request(restarted).get("/api/me").set("Cookie", String(login.headers["set-cookie"]).split(";")[0]!).expect(401);
  await agent.post("/auth/logout").expect(403);
  await agent.post("/auth/logout").type("form").send({ csrf: "wrong" }).expect(403);
  const csrf = (await agent.get("/api/session")).body.csrf;
  await agent.post("/auth/logout").type("form").send({ csrf }).expect(200);
  await agent.get("/api/me").expect(401);
  const nextState = (await begin(agent)).url.searchParams.get("state");
  await agent.get("/auth/callback").query({ state: nextState, code: "y" }).expect(302);
  advance(120_001);
  await agent.get("/api/me").expect(401);
  await request(app).get("/health").expect(200, { status: "ok" });
});

test("local absolute lifetime is enforced even with a longer provider token", async () => {
  let time = Date.now();
  const app = createApp({ ...config, sessionMaxAgeMs: 300_000 }, { now: () => time, oauth: { ...unusedOAuth, async exchange() {
    return { tokens: { accessToken: "fixture-access", scopes: [] }, profile: { ...profile }, expiresAt: time + 3_600_000 };
  } } });
  const agent = request.agent(app);
  const state = (await begin(agent)).url.searchParams.get("state");
  await agent.get("/auth/callback").query({ state, code: "x" }).expect(302);
  time += 300_001;
  await agent.get("/api/me").expect(401);
});

test("upstream errors are generic, consumed, and never create a session", async () => {
  const app = createApp(config, { oauth: { ...unusedOAuth, async exchange() { throw new Error("sensitive-token-and-secret"); } } });
  const agent = request.agent(app);
  const state = (await begin(agent)).url.searchParams.get("state");
  const error = await agent.get("/auth/callback").query({ state, code: "x" }).expect(303);
  assert.doesNotMatch(error.text, /sensitive-token-and-secret/);
  await agent.get("/api/me").expect(401);
  await agent.get("/auth/callback").query({ state, code: "x" }).expect(303);
});

test("HTTPS hosting emits a Secure cookie", async () => {
  const app = createApp({ ...config, secureCookie: true, appUrl: "https://example.test" });
  // Simulate a TLS host; the production entrypoint does not implicitly trust arbitrary proxies.


  const response = await request(app).get("/auth/login").set("X-Forwarded-Proto", "https").expect(302);
  assert.match(String(response.headers["set-cookie"]), /Secure/);
});

test("configuration rejects production, invalid origins, empty secrets and placeholders", () => {
  const env = { RITA_CLIENT_ID: "client", RITA_CLIENT_SECRET: "secret", SESSION_SECRET: "b".repeat(32) };
  for (const extra of [
    { NODE_ENV: "production" }, { SESSION_MAX_AGE_HOURS: "0" }, { SESSION_MAX_AGE_HOURS: "NaN" }, { SESSION_MAX_AGE_HOURS: "25" }, { PORT: "0" }, { PORT: "NaN" },
    { APP_BASE_URL: "ftp://example.com" }, { APP_BASE_URL: "https://a/b" },
    { RITA_PORTAL_URL: "https://a/b" },
    { RITA_PORTAL_URL: "https://user:pass@example.com" }, { MAX_SESSION_ENTRIES: "0" },
    { RITA_CLIENT_SECRET: "" }, { RITA_CLIENT_ID: "replace-me" },
  ]) assert.throws(() => readConfig({ ...env, ...extra }));
});

test("configuration supports API base paths and normalizes trailing slashes", () => {
  const env = { RITA_CLIENT_ID: "client", RITA_CLIENT_SECRET: "secret", SESSION_SECRET: "b".repeat(32) };
  assert.equal(readConfig(env).portalUrl, "http://localhost:3000");
  assert.equal(readConfig(env).apiUrl, "http://localhost:3000/api");
  for (const [input, expected] of [
    ["http://localhost:3000/api", "http://localhost:3000/api"],
    ["http://localhost:3000/api/", "http://localhost:3000/api"],
    ["https://example.com/gateway/api///", "https://example.com/gateway/api"],
    ["http://localhost:4000", "http://localhost:4000"],
    ["http://localhost:4000/", "http://localhost:4000"],
  ]) assert.equal(readConfig({ ...env, RITA_API_URL: input }).apiUrl, expected);
  for (const input of ["", "/api", "ftp://example.com/api", "https://user:pass@example.com/api",
    "https://example.com/api?x=1", "https://example.com/api#hash", "https://example.com/api?", "https://example.com/api#"]) {
    assert.throws(() => readConfig({ ...env, RITA_API_URL: input }), /RITA_API_URL/);
  }
});


