import { Router, type ErrorRequestHandler, type RequestHandler } from "express";
import { SessionError } from "./oauth-sessions.js";
import { same } from "./security.js";
import { clearBrowserCookie } from "./session.js";
import { RitaAuthStrategy, RitaAuthError, type RitaAuthStrategyOptions } from "./rita-auth.strategy.js";

export function createAuthRouter(options: RitaAuthStrategyOptions & { callbackResponse?: "redirect" | "json" }) {
  const { config, sessions, callbackResponse = "redirect" } = options;
  const router = Router();
  const strategy = new RitaAuthStrategy(options);
  router.get("/auth/login", strategy.login);
  router.get("/auth/callback", strategy.callback, (req, res) => {
    if (callbackResponse === "json") res.json(req.auth);
    else res.redirect("/?auth=success");
  });
  const callbackError: ErrorRequestHandler = (error, _req, res, _next) => {
    const code = error instanceof RitaAuthError ? error.code : "authentication_failed";
    if (callbackResponse === "json") res.status(error instanceof RitaAuthError ? error.status : 500).json({ error: code });
    else res.redirect(303, "/?auth=" + encodeURIComponent(code));
  };
  router.use("/auth/callback", callbackError);
  const csrf: RequestHandler = (req, res, next) => {
    const entry = sessions.browser(req.browserId);
    if (!entry) {
      if (req.path === "/auth/logout") { next(); return; }
      res.status(401).json({ error: "not_authenticated" }); return;
    }
    if (typeof req.body?.csrf !== "string" || !same(req.body.csrf, entry.csrf)) {
      res.status(403).json({ error: "invalid_csrf" }); return;
    }
    next();
  };
  router.post("/auth/refresh", csrf, async (req, res, next) => {
    try {
      if (!req.browserId) throw new SessionError("not_authenticated", 401);
      const identity = await sessions.resolve(req.browserId, true);
      res.json({ profile: identity.profile, session: await sessions.status(req.browserId) });
    } catch (error) { next(error); }
  });
  router.post("/auth/logout", csrf, async (req, res) => {
    const closing = req.browserId ? sessions.close(req.browserId) : Promise.resolve(true);
    // Clear immediately in this response; close has already canceled callbacks synchronously.
    clearBrowserCookie(res, config);
    // Deliver cookie deletion before a slow revoke can race with a new login in another tab.
    res.status(200).type("json").flushHeaders();
    res.end(JSON.stringify({ loggedOut: true, revokeConfirmed: await closing }));
  });
  return router;
}
