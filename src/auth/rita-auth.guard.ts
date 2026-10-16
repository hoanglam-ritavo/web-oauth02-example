import type { RequestHandler } from "express";
import "./session.js";

export interface RitaAuthGuardOptions {
  unauthenticated?: "unauthorized" | "redirect";
  now?: () => number;
}

/** Protects routes using the server session established by the Rita ID callback. */
export class RitaAuthGuard {
  private readonly now: () => number;
  private readonly unauthenticated: "unauthorized" | "redirect";

  constructor(options: RitaAuthGuardOptions = {}) {
    this.now = options.now ?? Date.now;
    this.unauthenticated = options.unauthenticated ?? "unauthorized";
  }

  // Arrow function keeps the instance bound when passed directly to Express.
  readonly handle: RequestHandler = (req, res, next) => {
    delete req.auth;
    res.set("Cache-Control", "no-store");
    const identity = req.session?.identity;
    if (identity && Number.isFinite(identity.expiresAt) && identity.expiresAt > this.now()) {
      req.auth = { profile: identity.profile, expiresAt: identity.expiresAt };
      next();
      return;
    }

    if (identity) delete req.session.identity;
    if (this.unauthenticated === "redirect") {
      res.redirect(303, "/auth/login");
      return;
    }
    res.status(401).json({ error: "not_authenticated" });
  };
}
