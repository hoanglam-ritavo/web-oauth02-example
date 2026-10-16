import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import type { Config } from "./config.js";
import { createOAuthClient, type OAuthClient } from "./auth/oauth-client.js";
import { createPendingClaims } from "./auth/pending-claims.js";
import { createSessionMiddleware, expireIdentity } from "./auth/session.js";
import { createAuthRouter } from "./auth/routes.js";
import { createPublicRouter } from "./routes/public.js";
import { page } from "./views/page.js";

export function createApp(
  config: Config,
  options: { oauth?: OAuthClient; now?: () => number; callbackResponse?: "redirect" | "json" } = {},
) {
  const app = express();
  const now = options.now ?? Date.now;
  const oauth = options.oauth ?? createOAuthClient(config, { now });
  const pendingClaims = createPendingClaims(now);
  if (config.secureCookie) app.set("trust proxy", "loopback");
  app.disable("x-powered-by");
  app.use(
    helmet({
      strictTransportSecurity: config.secureCookie ? undefined : false,
      contentSecurityPolicy: {
        directives: {
          "upgrade-insecure-requests": config.secureCookie ? [] : null,
        },
      },
    }),
  );
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.urlencoded({ extended: false, limit: "4kb" }));
  app.use(createSessionMiddleware(config));
  app.use(expireIdentity(now));
  app.use(createPublicRouter(now));
  app.use(createAuthRouter({ config, oauth, now, pendingClaims, callbackResponse: options.callbackResponse }));
  app.use((_req, res) => {
    res.status(404).send("Not found");
  });
  const onError: ErrorRequestHandler = (_error, _req, res, _next) => {
    res
      .status(500)
      .type("html")
      .send(
        page(undefined, undefined, "Có lỗi xử lý yêu cầu. Vui lòng thử lại."),
      );
  };
  app.use(onError);
  return app;
}
