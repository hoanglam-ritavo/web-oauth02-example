import type { RequestHandler } from "express";
import type { Config } from "../config.js";
import { ProviderError, type OAuthClient, type Authorization } from "./oauth-client.js";
import { OAuthSessions } from "./oauth-sessions.js";
import { type PendingClaims } from "./pending-claims.js";
import { random, same, pkceChallenge } from "./security.js";
import { saveSession, regenerateSession } from "./session.js";

export type RitaAuthErrorCode = "invalid_state" | "access_denied" | "missing_code" |
  "authentication_failed" | "integration_error";
export class RitaAuthError extends Error {
  constructor(readonly code: RitaAuthErrorCode, readonly status: number, message: string) {
    super(message); this.name = "RitaAuthError";
  }
}
export interface RitaAuthStrategyOptions {
  config: Config; oauth: OAuthClient; sessions: OAuthSessions;
  pendingClaims: PendingClaims; now?: () => number;
}
/** Wire one shared store and claim registry into strategy, guard and logout. */
export class RitaAuthStrategy {
  private readonly now: () => number;
  constructor(private readonly options: RitaAuthStrategyOptions) {
    this.now = options.now ?? Date.now;
  }
  readonly login: RequestHandler = async (req, res, next) => {
    try {
      const { config, pendingClaims } = this.options;
      pendingClaims.prune();
      const pending = { state: random(), verifier: random(), expiresAt: this.now() + 600_000 };
      req.session.pending = pending;
      req.session.csrf ??= random();
      req.session.cookie.maxAge = req.session.deadline
        ? Math.max(0, req.session.deadline - this.now()) : 600_000;
      pendingClaims.replace(req.sessionID, pending.state, pending.expiresAt);
      await saveSession(req);
      const target = new URL("/oauth/authorize", config.portalUrl);
      target.search = new URLSearchParams({
        client_id: config.clientId, redirect_uri: config.callbackUrl, response_type: "code",
        scope: "openid profile email", state: pending.state,
        code_challenge: pkceChallenge(pending.verifier), code_challenge_method: "S256",
      }).toString();
      res.redirect(target.toString());
    } catch (error) { next(error); }
  };
  readonly callback: RequestHandler = async (req, res, next) => {
    delete req.auth;
    const { oauth, sessions, pendingClaims, config } = this.options;
    let authorization: Authorization | undefined;
    let createdId: string | undefined;
    let claimedState: string | undefined;
    try {
      const state = req.query.state;
      const pending = req.session.pending;
      pendingClaims.prune();
      const claim = typeof state === "string" ? pendingClaims.get(state) : undefined;
      if (typeof state !== "string" || !pending || !same(state, pending.state) ||
          pending.expiresAt <= this.now() || claim?.sessionId !== req.sessionID ||
          !claim.active || claim.claimed) {
        throw new RitaAuthError("invalid_state", 400, "Yêu cầu đăng nhập không hợp lệ hoặc đã hết hạn.");
      }
      claim.claimed = true; // synchronous before any await; logout can still cancel this claim.
      claimedState = state;
      const ensureActive = () => {
        if (!claim.active || claim.expiresAt <= this.now()) {
          throw new RitaAuthError("invalid_state", 400, "Yêu cầu đăng nhập đã bị hủy.");
        }
      };
      delete req.session.pending;
      await saveSession(req);
      if (req.query.error !== undefined) {
        throw new RitaAuthError("access_denied", 400, "Đăng nhập đã bị từ chối hoặc hủy.");
      }
      const code = req.query.code;
      if (typeof code !== "string" || !code) {
        throw new RitaAuthError("missing_code", 400, "Không nhận được authorization code.");
      }
      try {
        authorization = await oauth.exchange(code, pending.verifier);
        if (!Number.isFinite(authorization.expiresAt) || authorization.expiresAt <= this.now()) {
          throw new Error("Expired identity.");
        }
      } catch (error) {
        if (error instanceof ProviderError && ["invalid_client", "unauthorized_client", "invalid_scope"].includes(error.code)) {
          throw new RitaAuthError("integration_error", 502, "Kiểm tra cấu hình client và quyền OAuth của ứng dụng.");
        }
        throw new RitaAuthError("authentication_failed", 502, "Không thể hoàn tất đăng nhập Rita ID. Vui lòng thử lại.");
      }
      ensureActive();
      if (req.session.oauthId) await sessions.close(req.session.oauthId);
      ensureActive();
      await regenerateSession(req);
      ensureActive();
      createdId = req.sessionID;
      const deadline = sessions.add(createdId, authorization, this.now() + config.sessionMaxAgeMs);
      req.session.oauthId = createdId;
      req.session.csrf = random();
      req.session.deadline = deadline;
      req.session.cookie.maxAge = deadline - this.now();
      await saveSession(req);
      ensureActive();
      req.auth = { profile: authorization.profile, expiresAt: authorization.expiresAt };
    } catch (error) {
      if (createdId) {
        await sessions.close(createdId);
        req.session.destroy(() => undefined);
      } else if (authorization?.tokens.refreshToken) {
        await oauth.revoke(authorization.tokens.refreshToken).catch(() => undefined);
      }
      next(error);
      return;
    } finally {
      if (claimedState) pendingClaims.delete(claimedState);
    }
    next();
  };
}
