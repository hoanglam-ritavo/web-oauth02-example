import { Router, type ErrorRequestHandler, type RequestHandler } from "express";
import type { Config } from "../config.js";
import type { OAuthClient } from "./oauth-client.js";
import type { PendingClaims } from "./pending-claims.js";
import { OAuthSessions, SessionError } from "./oauth-sessions.js";
import { same } from "./security.js";
import { cookieName, sessionCookie } from "./session.js";
import { RitaAuthStrategy, RitaAuthError } from "./rita-auth.strategy.js";
import { page } from "../views/page.js";

export function createAuthRouter(options: {
  config: Config; oauth: OAuthClient; now: () => number;
  sessions: OAuthSessions; pendingClaims: PendingClaims; callbackResponse?: "redirect" | "json";
}) {
  const { config, sessions, pendingClaims, callbackResponse = "redirect" } = options;
  const router = Router();
  const strategy = new RitaAuthStrategy(options);
  router.get("/auth/login", strategy.login);
  router.get("/auth/callback", strategy.callback, (req, res) => {
    if (callbackResponse === "json") res.json(req.auth);
    else res.redirect("/");
  });
  const callbackError: ErrorRequestHandler = (error, _req, res, next) => {
    if (!(error instanceof RitaAuthError)) {
      if (callbackResponse === "json") res.status(500).json({ error: "internal_error" });
      else next(error);
      return;
    }
    if (callbackResponse === "json") res.status(error.status).json({ error: error.code });
    else res.status(error.status).type("html").send(page(undefined, undefined, error.message));
  };
  router.use("/auth/callback", callbackError);
  const csrf: RequestHandler = (req, res, next) => {
    if (typeof req.body?.csrf !== "string" || !req.session.csrf ||
        !same(req.body.csrf, req.session.csrf)) {
      res.status(403).json({ error: "invalid_csrf" });
      return;
    }
    next();
  };
  router.post("/auth/refresh", csrf, async (req, res, next) => {
    try {
      if (!req.session.oauthId || req.session.oauthId !== req.sessionID) throw new SessionError("not_authenticated", 401);
      await sessions.resolve(req.session.oauthId, true);
      res.redirect(303, "/");
    } catch (error) { next(error); }
  });
  router.post("/auth/logout", csrf, async (req, res, next) => {
    // Cancel callbacks synchronously, including already claimed/in-flight callbacks.
    pendingClaims.cancelSession(req.sessionID);
    const closing = sessions.close(req.session.oauthId ?? req.sessionID);
    const revoked = await closing;
    req.session.destroy(error => {
      if (error) { next(error); return; }
      res.clearCookie(cookieName, sessionCookie(config));
      res.redirect(303, revoked ? "/" : "/?notice=revoke_unconfirmed");
    });
  });
  return router;
}
