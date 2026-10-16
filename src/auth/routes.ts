import { Router, type ErrorRequestHandler } from "express";
import type { Config } from "../config.js";
import type { OAuthClient } from "./oauth-client.js";
import type { PendingClaims } from "./pending-claims.js";
import { same } from "./security.js";
import { cookieName, sessionCookie } from "./session.js";
import { RitaAuthStrategy, RitaAuthError } from "./rita-auth.strategy.js";
import { page } from "../views/page.js";

export function createAuthRouter({
  config,
  oauth,
  now,
  pendingClaims,
  callbackResponse = "redirect",
}: {
  callbackResponse?: "redirect" | "json";
  config: Config;
  oauth: OAuthClient;
  now: () => number;
  pendingClaims: PendingClaims;
}) {
  const router = Router();
  const cookie = sessionCookie(config);
  const strategy = new RitaAuthStrategy({ config, oauth, now, pendingClaims });
  router.get("/auth/login", strategy.login);

  router.get("/auth/callback", strategy.callback, (req, res) => {
    console.log("req.auth : ", req.auth);

    if (callbackResponse === "json") {
      res.json(req.auth);
      return;
    }
    res.redirect("/");
  });

  const callbackError: ErrorRequestHandler = (error, _req, res, next) => {
    if (!(error instanceof RitaAuthError)) {
      if (callbackResponse === "json") {
        res.status(500).json({ error: "internal_error" });
        return;
      }
      next(error);
      return;
    }
    if (callbackResponse === "json") {
      res.status(error.status).json({ error: error.code });
      return;
    }
    res
      .status(error.status)
      .type("html")
      .send(page(undefined, undefined, error.message));
  };
  router.use("/auth/callback", callbackError);
  router.post("/auth/logout", async (req, res, next) => {
    const csrf: unknown = req.body?.csrf;
    if (
      !req.session.identity ||
      typeof csrf !== "string" ||
      !same(csrf, req.session.identity.csrf)
    ) {
      res
        .status(403)
        .type("html")
        .send(page(undefined, undefined, "Yêu cầu đăng xuất không hợp lệ."));
      return;
    }
    if (req.session.pending) pendingClaims.delete(req.session.pending.state);
    req.session.destroy((error) => {
      if (error) {
        next(error);
        return;
      }
      res.clearCookie(cookieName, cookie);
      res.redirect(303, "/");
    });
  });
  return router;
}
