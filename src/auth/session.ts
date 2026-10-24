import type { Request, RequestHandler, Response } from "express";
import type { WebConfig } from "../config.js";
import type { Identity } from "./oauth-client.js";
import { OAuthSessions, keyHash } from "./oauth-sessions.js";

declare global { namespace Express { interface Request { auth?: Identity; browserId?: string } } }
export const cookieName = "rita_example.key";
export const sessionCookie = (config: WebConfig) => ({
  httpOnly: true, sameSite: "lax" as const, secure: config.secureCookie, path: "/",
});
export function createSessionMiddleware(config: WebConfig, sessions: OAuthSessions): RequestHandler {
  return (req, res, next) => {
    const cookies = (req.headers.cookie ?? "").split(";").map(value => value.trim());
    const values = cookies.filter(value => value.split("=", 1)[0] === cookieName);
    const key = values.length === 1 ? values[0]!.slice(cookieName.length + 1) : "";
    if (/^[A-Za-z0-9_-]{43}$/.test(key)) {
      const id = keyHash(key);
      if (sessions.browser(id)) req.browserId = id;
    }
    // Never clear an invalid key on a read response: a late response could erase a newer login cookie.
    if (cookies.some(value => value.startsWith("rita_example.sid=")))
      res.clearCookie("rita_example.sid", sessionCookie(config));
    next();
  };
}
export function ensureBrowser(req: Request, res: Response, config: WebConfig, sessions: OAuthSessions, now: () => number) {
  if (!sessions.browser(req.browserId)) {
    const created = sessions.create();
    req.browserId = created.id;
    setBrowserCookie(res, config, created.key, created.deadline - now());
  }
  return sessions.browser(req.browserId)!;
}
export function setBrowserCookie(res: Response, config: WebConfig, key: string, maxAge: number) {
  res.cookie(cookieName, key, { ...sessionCookie(config), maxAge: Math.max(0, maxAge) });
}
export const clearBrowserCookie = (res: Response, config: WebConfig) => res.clearCookie(cookieName, sessionCookie(config));
