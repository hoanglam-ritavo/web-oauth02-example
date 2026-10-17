import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { createOAuthClient, type OAuthClient } from "./auth/oauth-client.js";
import { createPendingClaims } from "./auth/pending-claims.js";
import { OAuthSessions, SessionError } from "./auth/oauth-sessions.js";
import { createSessionMiddleware, destroySession, wantsJson } from "./auth/session.js";
import { createAuthRouter } from "./auth/routes.js";
import { createPublicRouter } from "./routes/public.js";
import { renderPage } from "./views/page.js";

export function createApp(config: Config, options: {
  oauth?: OAuthClient; now?: () => number; callbackResponse?: "redirect" | "json";
} = {}) {
  const app = express();
  const now = options.now ?? Date.now;
  const oauth = options.oauth ?? createOAuthClient(config, { now });
  const pendingClaims = createPendingClaims(now);
  const sessions = new OAuthSessions(oauth, now);
  if (config.secureCookie) app.set("trust proxy", "loopback");
  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", fileURLToPath(new URL("./views", import.meta.url)));
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
  app.use(createSessionMiddleware(config));
  app.use((req, _res, next) => {
    if (req.session.deadline) req.session.cookie.maxAge = Math.max(0, req.session.deadline - now());
    next();
  });
  app.use(createPublicRouter(sessions));
  app.use(createAuthRouter({ config, oauth, now, sessions, pendingClaims, callbackResponse: options.callbackResponse }));
  app.use((_req, res) => res.status(404).send("Not found"));
  const onError: ErrorRequestHandler = async (error, req, res, _next) => {
    const status = error instanceof SessionError ? error.status : 500;
    const code = error instanceof SessionError ? error.code : "internal_error";
    if (error instanceof SessionError && error.retryAfter) res.set("Retry-After", String(error.retryAfter));
    if (status === 401) {
      try {
        if (req.session?.oauthId) await sessions.close(req.session.oauthId);
        await destroySession(req, res);
      } catch { res.status(500).json({ error: "internal_error" }); return; }
    }
    if (wantsJson(req)) {
      res.status(status).json({ error: code });
      return;
    }
    const messages: Record<string, string> = {
      forbidden: "Bạn không có quyền truy cập tài nguyên này.",
      not_authenticated: "Phiên đã kết thúc. Vui lòng đăng nhập lại.",
      integration_error: "Lỗi tích hợp: kiểm tra client credentials, grant và scope. Đăng nhập lại không tự sửa cấu hình.",
      temporarily_unavailable: "Rita ID tạm thời không khả dụng. Thử lại sau ít nhất 5 giây.",
      refresh_unavailable: "Phiên này không có refresh token.",
      internal_error: "Có lỗi xử lý yêu cầu. Vui lòng thử lại.",
    };
    renderPage(res.status(status), req.session?.csrf, messages[code] ?? messages.internal_error);
  };
  app.use(onError);
  return app;
}
