import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { RitaAuthGuard } from "../src/auth/rita-auth.guard.js";
import { createSessionMiddleware } from "../src/auth/session.js";
import { readConfig } from "../src/config.js";

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
  app.get("/protected", new RitaAuthGuard().handle, (_req, res) => res.sendStatus(200));
  await request(app).get("/protected").set("Authorization", "Bearer arbitrary")
    .expect(401, { error: "not_authenticated" });
});

test("guard independently enforces expiry and exposes only profile and expiry", async () => {
  let time = Date.now();
  const expiresAt = time + 60_000;
  const app = express();
  app.use(createSessionMiddleware(config));
  // Test-only login fixture; no expireIdentity middleware is installed.
  app.post("/fixture", (req, res) => {
    req.session.identity = { profile, expiresAt, csrf: "private-csrf" };
    res.sendStatus(204);
  });
  let handled = 0;
  app.get("/protected", new RitaAuthGuard({ now: () => time }).handle, (req, res) => {
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

test("redirect mode sends unauthenticated requests to the fixed login route", async () => {
  const app = express();
  app.use(createSessionMiddleware(config));
  app.post("/fixture", (req, res) => {
    req.session.pending = { state: "pending", verifier: "private", expiresAt: Date.now() + 60_000 };
    res.sendStatus(204);
  });
  app.all("/protected", new RitaAuthGuard({ unauthenticated: "redirect" }).handle,
    (_req, res) => res.sendStatus(200));
  const agent = request.agent(app);
  await agent.post("/fixture").expect(204);
  for (const method of ["get", "post"] as const) {
    await agent[method]("/protected?returnTo=https://untrusted.example")
      .expect(303).expect("Location", "/auth/login");
  }
});
