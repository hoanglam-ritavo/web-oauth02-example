import type { RequestHandler } from "express";
import { OAuthSessions, SessionError } from "./oauth-sessions.js";
import { destroySession } from "./session.js";

export interface RitaAuthGuardOptions {
  sessions: OAuthSessions;
  unauthenticated?: "unauthorized" | "redirect";
}
export class RitaAuthGuard {
  constructor(private readonly options: RitaAuthGuardOptions) {}
  readonly handle: RequestHandler = async (req, res, next) => {
    delete req.auth;
    res.set("Cache-Control", "no-store");
    try {
      if (!req.session?.oauthId || req.session.oauthId !== req.sessionID) {
        throw new SessionError("not_authenticated", 401);
      }
      req.auth = await this.options.sessions.resolve(req.session.oauthId);
      next();
    } catch (error) {
      if (error instanceof SessionError && error.status === 401) {
        try {
          if (req.session?.oauthId) await this.options.sessions.close(req.session.oauthId);
          await destroySession(req, res);
        } catch (cleanupError) { next(cleanupError); return; }
        if (this.options.unauthenticated === "redirect") res.redirect(303, "/auth/login");
        else res.status(401).json({ error: "not_authenticated" });
      } else next(error);
    }
  };
}
