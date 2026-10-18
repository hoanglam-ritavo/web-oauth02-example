import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { createOAuthClient, type OAuthClient } from "./auth/oauth-client.js";
import { OAuthSessions, SessionError } from "./auth/oauth-sessions.js";
import { createSessionMiddleware } from "./auth/session.js";
import { createAuthRouter } from "./auth/routes.js";
import { createPublicRouter } from "./routes/public.js";

export function createApp(config: Config, options: {
  oauth?: OAuthClient; now?: () => number; callbackResponse?: "redirect" | "json";
} = {}) {
  const app = express();
  const now = options.now ?? Date.now;
  const oauth = options.oauth ?? createOAuthClient(config, { now });
  const sessions = new OAuthSessions(oauth, now, config.maxSessionEntries);
  if (config.secureCookie) app.set("trust proxy", "loopback");
  app.disable("x-powered-by");
  app.use(helmet({
    strictTransportSecurity: config.secureCookie ? undefined : false,
    contentSecurityPolicy: { directives: { "upgrade-insecure-requests": config.secureCookie ? [] : null } },
  }));
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.get("/assets/axios.min.js", (_req, res) => {
    const bundled = fileURLToPath(new URL("./public/axios.min.js", import.meta.url));
    res.sendFile(existsSync(bundled) ? bundled : join(dirname(createRequire(import.meta.url).resolve("axios/package.json")), "dist/axios.min.js"));
  });
  app.use("/assets", express.static(fileURLToPath(new URL("./public", import.meta.url))));
  app.use(express.json({ limit: "4kb" }));
  app.use(express.urlencoded({ extended: false, limit: "4kb" }));
  app.use(createSessionMiddleware(config, sessions));
  app.use((req, res, next) => {
    if (req.method === "POST" && req.get("Origin") !== undefined && req.get("Origin") !== config.appUrl) {
      res.status(403).json({ error: "invalid_origin" }); return;
    }
    next();
  });
  app.use(createPublicRouter(sessions, config, now));
  app.use(createAuthRouter({ config, oauth, now, sessions, callbackResponse: options.callbackResponse }));
  app.use((req, res) => {
    const reserved = /^\/(api|auth|assets)(\/|$)/.test(req.path);
    if (req.method === "GET" && !reserved && !req.path.split("/").pop()?.includes(".") && req.accepts("html")) {
      res.sendFile(fileURLToPath(new URL("./public/index.html", import.meta.url)));
    } else res.status(404).json({ error: "not_found" });
  });
  const onError: ErrorRequestHandler = async (error, req, res, _next) => {
    const parserStatus = error?.type === "entity.parse.failed" ? 400 : error?.type === "entity.too.large" ? 413 : undefined;
    const status = error instanceof SessionError ? error.status : parserStatus ?? 500;
    const code = error instanceof SessionError ? error.code : parserStatus === 400 ? "invalid_body" : parserStatus === 413 ? "body_too_large" : "internal_error";
    if (error instanceof SessionError && error.retryAfter) res.set("Retry-After", String(error.retryAfter));
    if (status === 401 && req.browserId) await sessions.close(req.browserId);
    res.status(status).json({ error: code });
  };
  app.use(onError);
  return app;
}
