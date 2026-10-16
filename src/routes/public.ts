import { Router } from "express";
import { page } from "../views/page.js";
import { RitaAuthGuard } from "../auth/rita-auth.guard.js";

export function createPublicRouter(now: () => number = Date.now) {
  const router = Router();
  const auth = new RitaAuthGuard({ now });
  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  router.get("/", (req, res) => {
    res
      .type("html")
      .send(page(req.session.identity?.profile, req.session.identity?.csrf));
  });
  router.get("/api/me", auth.handle, (req, res) => {
    res.json(req.auth!.profile);
  });
  return router;
}
