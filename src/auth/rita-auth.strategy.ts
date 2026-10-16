import type { RequestHandler } from "express";
import type { Config } from "../config.js";
import { createOAuthClient, type OAuthClient, type Identity } from "./oauth-client.js";
import { createPendingClaims, type PendingClaims } from "./pending-claims.js";
import { random, same, pkceChallenge } from "./security.js";
import { saveSession, regenerateSession } from "./session.js";

export type RitaAuthErrorCode = "invalid_state" | "access_denied" | "missing_code" | "authentication_failed";

export class RitaAuthError extends Error {
  constructor(readonly code: RitaAuthErrorCode, readonly status: number, message: string) {
    super(message);
    this.name = "RitaAuthError";
  }
}

export interface RitaAuthStrategyOptions {
  config: Config;
  oauth?: OAuthClient;
  now?: () => number;
  pendingClaims?: PendingClaims;
}

/** Express session strategy. Use one instance for login and callback in each app. */
export class RitaAuthStrategy {
  private readonly config: Config;
  private readonly oauth: OAuthClient;
  private readonly now: () => number;
  private readonly pendingClaims: PendingClaims;

  constructor(options: RitaAuthStrategyOptions) {
    this.config = options.config;
    this.now = options.now ?? Date.now;
    this.oauth = options.oauth ?? createOAuthClient(options.config, { now: this.now });
    this.pendingClaims = options.pendingClaims ?? createPendingClaims(this.now);
  }

  readonly login: RequestHandler = async (req, res, next) => {
    try {
      const { config, now, pendingClaims } = this;
      res.set("Cache-Control", "no-store");
      pendingClaims.prune();
      if (req.session.pending) pendingClaims.delete(req.session.pending.state);
      const pending = {
        state: random(), verifier: random(), expiresAt: now() + 10 * 60_000,
      };
      req.session.pending = pending;
      req.session.cookie.maxAge = 10 * 60_000;
      pendingClaims.replace(req.sessionID, pending.state, pending.expiresAt);
      await saveSession(req);
      const target = new URL("/oauth/authorize", config.portalUrl);
      target.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.callbackUrl,
        response_type: "code",
        scope: "openid profile email",
        state: pending.state,
        code_challenge: pkceChallenge(pending.verifier),
        code_challenge_method: "S256",
      }).toString();
      res.redirect(target.toString());
    } catch (error) {
      next(error);
    }
  };

  /** Establishes the session and req.auth, then delegates the response to the route. */
  readonly callback: RequestHandler = async (req, res, next) => {
    delete req.auth;
    res.set("Cache-Control", "no-store");
    try {
      const { now, pendingClaims } = this;
      const state = req.query.state;
      const pending = req.session.pending;
      pendingClaims.prune();
      const claim = typeof state === "string" ? pendingClaims.get(state) : undefined;
      if (typeof state !== "string" || !pending || !same(state, pending.state) ||
          pending.expiresAt <= now() || claim?.sessionId !== req.sessionID) {
        throw new RitaAuthError("invalid_state", 400, "Yêu cầu đăng nhập không hợp lệ hoặc đã hết hạn.");
      }
      // Claim synchronously before any await, including session persistence.
      pendingClaims.delete(state);
      delete req.session.pending;
      await saveSession(req);
      if (req.query.error !== undefined) {
        throw new RitaAuthError("access_denied", 400, "Đăng nhập đã bị từ chối hoặc hủy.");
      }
      const code = req.query.code;
      if (typeof code !== "string" || !code) {
        throw new RitaAuthError("missing_code", 400, "Không nhận được authorization code.");
      }
      let identity: Identity;
      try {
        identity = await this.oauth.exchange(code, pending.verifier);
        if (!Number.isFinite(identity.expiresAt) || identity.expiresAt <= now()) {
          throw new Error("Expired identity.");
        }
      } catch {
        throw new RitaAuthError("authentication_failed", 502,
          "Không thể hoàn tất đăng nhập Rita ID. Vui lòng thử lại.");
      }
      const expiresAt = Math.min(now() + 5 * 60_000, identity.expiresAt);
      await regenerateSession(req);
      req.session.identity = { profile: identity.profile, expiresAt, csrf: random() };
      req.session.cookie.maxAge = expiresAt - now();
      await saveSession(req);
      req.auth = { profile: identity.profile, expiresAt };
    } catch (error) {
      next(error);
      return;
    }
    next();
  };
}
