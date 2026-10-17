import type { Response } from "express";
import type { SessionStatus } from "../auth/oauth-sessions.js";

export function renderPage(res: Response, csrf?: string, message?: string, status?: SessionStatus) {
  return res.render("page", { csrf, message, status });
}
