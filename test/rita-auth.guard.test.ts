import { OAuthSessions } from "../src/auth/oauth-sessions.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { RitaAuthGuard } from "../src/auth/rita-auth.guard.js";
import { createSessionMiddleware, setBrowserCookie } from "../src/auth/session.js";
import { readConfig } from "../src/config.js";

const oauth = {
  async exchange(): Promise<never> { throw new Error("Unexpected exchange"); },
  async refresh(): Promise<never> { throw new Error("Unexpected refresh"); },
  async verify() { return { profile, expiresAt: Date.now() + 60_000 }; },
  async revoke() {},
};
const config = readConfig({
  RITA_CLIENT_ID: "test-client", RITA_CLIENT_SECRET: "test-secret",
  SESSION_SECRET: "s".repeat(32),
});
const profile = {
  sub: "12345678-1234-4123-8123-123456789012", name: "Demo",
  email: "demo@example.com", employee_id: null, phone_number: null,
  is_developer: false, groups: "EMPLOYEE" as const,
};

test("guard rejects missing session even with a bearer header or stale request auth", async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.auth = { profile, expiresAt: Date.now() + 60_000 };
    next();
  });
  app.get("/protected", new RitaAuthGuard({ sessions: new OAuthSessions(oauth) }).handle, (_req, res) => res.sendStatus(200));
  await request(app).get("/protected").set("Authorization", "Bearer arbitrary")
    .expect(401, { error: "not_authenticated" });
});

test("guard independently enforces expiry and exposes only profile and expiry", async () => {
  let time = Date.now();
  const expiresAt = time + 60_000;
  const sessions = new OAuthSessions({ ...oauth, async verify() { return { profile, expiresAt }; } }, () => time);
  const app = express();
  app.use(createSessionMiddleware(config, sessions));
  // Test-only login fixture; no expireIdentity middleware is installed.
  app.post("/fixture", (req, res) => {
    const created = sessions.create({ profile, expiresAt, tokens: { accessToken: "private-access", scopes: [] } }, expiresAt);
    setBrowserCookie(res, config, created.key, expiresAt - time);
    res.sendStatus(204);
  });
  let handled = 0;
  app.get("/protected", new RitaAuthGuard({ sessions }).handle, (req, res) => {
    handled++;
    res.json(req.auth);
  });
  const agent = request.agent(app);
  await agent.get("/protected").expect(401);
  await agent.post("/fixture").expect(204);
  const response = await agent.get("/protected").expect(200, { profile, expiresAt });
  assert.equal(response.headers["cache-control"], "no-store");
  time = expiresAt;
  await agent.get("/protected").expect(401);
  assert.equal(handled, 1);
});

test("anonymous guard requests return JSON without redirecting or accepting bearer tokens", async () => {
  const app = express();
  const sessions = new OAuthSessions(oauth);
  app.use(createSessionMiddleware(config, sessions));
  app.all("/protected", new RitaAuthGuard({ sessions }).handle, (_req, res) => res.sendStatus(200));
  for (const method of ["get", "post"] as const) {
    await request(app)[method]("/protected?returnTo=https://untrusted.example").expect(401, { error: "not_authenticated" });
  }
});
