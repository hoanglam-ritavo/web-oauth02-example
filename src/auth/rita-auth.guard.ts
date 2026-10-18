import type { RequestHandler } from "express";
import { OAuthSessions, SessionError } from "./oauth-sessions.js";

export class RitaAuthGuard {
  constructor(private readonly options: { sessions: OAuthSessions }) {}
  readonly handle: RequestHandler = async (req, res, next) => {
    delete req.auth;
    res.set("Cache-Control", "no-store");
    try {
      if (!req.browserId) throw new SessionError("not_authenticated", 401);
      req.auth = await this.options.sessions.resolve(req.browserId);
      next();
    } catch (error) {
      if (error instanceof SessionError && error.status === 401) {
        if (req.browserId) await this.options.sessions.close(req.browserId);
        res.status(401).json({ error: "not_authenticated" });
      } else next(error);
    }
  };
}
