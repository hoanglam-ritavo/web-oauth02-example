import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import type { Config } from "./config.js";
import { createOAuthClient, type OAuthClient } from "./auth/oauth-client.js";
import { createPendingClaims } from "./auth/pending-claims.js";
import { OAuthSessions, SessionError } from "./auth/oauth-sessions.js";
import { createSessionMiddleware } from "./auth/session.js";
import { createAuthRouter } from "./auth/routes.js";
import { createPublicRouter } from "./routes/public.js";
import { page } from "./views/page.js";

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
  app.use(helmet({
    strictTransportSecurity: config.secureCookie ? undefined : false,
    contentSecurityPolicy: { directives: { "upgrade-insecure-requests": config.secureCookie ? [] : null } },
  }));
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.use(express.urlencoded({ extended: false, limit: "4kb" }));
  app.use(createSessionMiddleware(config));
  app.use((req, _res, next) => {
    if (req.session.deadline) req.session.cookie.maxAge = Math.max(0, req.session.deadline - now());
    next();
  });
  app.use(createPublicRouter(sessions));
  app.use(createAuthRouter({ config, oauth, now, sessions, pendingClaims, callbackResponse: options.callbackResponse }));
  app.use((_req, res) => res.status(404).send("Not found"));
  const onError: ErrorRequestHandler = (error, req, res, _next) => {
    const status = error instanceof SessionError ? error.status : 500;
    const code = error instanceof SessionError ? error.code : "internal_error";
    if (error instanceof SessionError && error.retryAfter) res.set("Retry-After", String(error.retryAfter));
    if (req.path.startsWith("/api/")) {
      res.status(status).json({ error: code });
      return;
    }
    const messages: Record<string, string> = {
      not_authenticated: "Phiên đã kết thúc. Vui lòng đăng nhập lại.",
      integration_error: "Lỗi tích hợp: kiểm tra client credentials, grant và scope. Đăng nhập lại không tự sửa cấu hình.",
      temporarily_unavailable: "Rita ID tạm thời không khả dụng. Thử lại sau ít nhất 5 giây.",
      refresh_unavailable: "Phiên này không có refresh token.",
      internal_error: "Có lỗi xử lý yêu cầu. Vui lòng thử lại.",
    };
    res.status(status).type("html").send(page(undefined, req.session?.csrf, messages[code] ?? messages.internal_error));
  };
  app.use(onError);
  return app;
}
