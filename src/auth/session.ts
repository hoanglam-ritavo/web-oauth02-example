import type { Request, RequestHandler } from "express";
import session from "express-session";
import type { Config } from "../config.js";
import type { Identity } from "./oauth-client.js";

declare global { namespace Express { interface Request { auth?: Identity } } }
declare module "express-session" {
  interface SessionData {
    pending?: { state: string; verifier: string; expiresAt: number };
    oauthId?: string;
    csrf?: string;
    deadline?: number;
  }
}
export const cookieName = "rita_example.sid";
export const sessionCookie = (config: Config) => ({
  httpOnly: true, sameSite: "lax" as const, secure: config.secureCookie, path: "/",
});
export function createSessionMiddleware(config: Config): RequestHandler {
  return session({
    name: cookieName, secret: config.sessionSecret, resave: false, saveUninitialized: false,
    cookie: { ...sessionCookie(config), maxAge: 10 * 60_000 },
  });
}
export const saveSession = (req: Request): Promise<void> =>
  new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
export const regenerateSession = (req: Request): Promise<void> =>
  new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
