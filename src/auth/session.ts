import type { Request, RequestHandler } from "express";
import session from "express-session";
import type { Config } from "../config.js";
import type { Identity } from "./oauth-client.js";

declare global {
  namespace Express {
    interface Request {
      auth?: Identity;
    }
  }
}

interface Pending {
  state: string;
  verifier: string;
  expiresAt: number;
}

declare module "express-session" {
  interface SessionData {
    pending?: Pending;
    identity?: Identity & { csrf: string };
  }
}

export const cookieName = "rita_example.sid";

export const sessionCookie = (config: Config) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: config.secureCookie,
  path: "/",
});

export function createSessionMiddleware(config: Config): RequestHandler {
  return session({
    name: cookieName,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { ...sessionCookie(config), maxAge: 10 * 60_000 },
  });
}

export function expireIdentity(now: () => number): RequestHandler {
  return (req, _res, next) => {
    if (req.session.identity && req.session.identity.expiresAt <= now())
      delete req.session.identity;
    next();
  };
}

export const saveSession = (req: Request): Promise<void> =>
  new Promise((resolve, reject) =>
    req.session.save((error) => (error ? reject(error) : resolve())),
  );

export const regenerateSession = (req: Request): Promise<void> =>
  new Promise((resolve, reject) =>
    req.session.regenerate((error) => (error ? reject(error) : resolve())),
  );
