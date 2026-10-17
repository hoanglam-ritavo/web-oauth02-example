import { Router } from "express";
import { page } from "../views/page.js";
import { RitaAuthGuard } from "../auth/rita-auth.guard.js";
import { OAuthSessions, SessionError } from "../auth/oauth-sessions.js";

export function createPublicRouter(sessions: OAuthSessions) {
  const router = Router();
  const auth = new RitaAuthGuard({ sessions });
  router.get("/health", (_req, res) => res.json({ status: "ok" }));
  router.get("/", async (req, res, next) => {
    try {
      let identity;
      let status;
      if (req.session.oauthId === req.sessionID) {
        try {
          identity = await sessions.resolve(req.sessionID);
          status = await sessions.status(req.sessionID);
        } catch (error) {
          if (!(error instanceof SessionError) || error.status !== 401) throw error;
        }
      }
      const notice = req.query.notice === "revoke_unconfirmed"
        ? "Đã xóa phiên local. Chưa xác nhận được việc thu hồi phiên OAuth phía Rita ID." : undefined;
      res.type("html").send(page(identity?.profile, req.session.csrf, notice, status));
    } catch (error) { next(error); }
  });
  router.get("/api/me", auth.handle, (req, res) => res.json(req.auth!.profile));
  router.get("/api/session", async (req, res, next) => {
    try {
      if (!req.session.oauthId || req.session.oauthId !== req.sessionID) throw new SessionError("not_authenticated", 401);
      res.json(await sessions.status(req.session.oauthId));
    } catch (error) { next(error); }
  });
  return router;
}
