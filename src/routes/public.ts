import { Router } from "express";
import type { WebConfig } from "../config.js";
import { ensureBrowser } from "../auth/session.js";
import { RitaAuthGuard } from "../auth/rita-auth.guard.js";
import { OAuthSessions } from "../auth/oauth-sessions.js";

export function createPublicRouter(sessions: OAuthSessions, config: WebConfig, now: () => number) {
  const router = Router();
  const auth = new RitaAuthGuard({ sessions });
  router.get("/api/me", auth.handle, (req, res) => res.json(req.auth!.profile));
  router.get("/api/private/example", auth.handle, (req, res) =>
    res.json({ message: "Private resource accessed.", subject: req.auth!.profile.sub }));
  router.get("/api/session", async (req, res, next) => {
    try {
      const entry = ensureBrowser(req, res, config, sessions, now);
      if (entry.failure?.status === 401) {
        await sessions.close(req.browserId!);
        const anonymous = ensureBrowser(req, res, config, sessions, now);
        res.json({ authenticated: false, csrf: anonymous.csrf, session: null }); return;
      }
      res.json({ authenticated: Boolean(entry.identity), csrf: entry.csrf,
        session: entry.identity ? await sessions.status(req.browserId!) : null });
    } catch (error) { next(error); }
  });
  return router;
}
