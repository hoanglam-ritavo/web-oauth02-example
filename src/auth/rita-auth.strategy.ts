import type { RequestHandler } from "express";
import type { Config } from "../config.js";
import { ProviderError, type OAuthClient, type Authorization } from "./oauth-client.js";
import { OAuthSessions } from "./oauth-sessions.js";
import { random, same, pkceChallenge } from "./security.js";
import { ensureBrowser, setBrowserCookie } from "./session.js";

export class RitaAuthError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
export interface RitaAuthStrategyOptions {
  config: Config; oauth: OAuthClient; sessions: OAuthSessions; now: () => number;
}
export class RitaAuthStrategy {
  constructor(private readonly options: RitaAuthStrategyOptions) {}
  readonly login: RequestHandler = (req, res, next) => {
    try {
      const { config, sessions, now } = this.options;
      const entry = ensureBrowser(req, res, config, sessions, now);
      if (entry.attempt) entry.attempt.active = false;
      const attempt = { state: random(), verifier: random(), expiresAt: Math.min(entry.deadline, now() + 600_000), active: true, claimed: false };
      entry.attempt = attempt;
      const target = new URL("/oauth/authorize", config.portalUrl);
      target.search = new URLSearchParams({ client_id: config.clientId,
        redirect_uri: config.callbackUrl, response_type: "code", scope: "openid profile email",
        state: attempt.state, code_challenge: pkceChallenge(attempt.verifier), code_challenge_method: "S256",
      }).toString();
      res.redirect(target.toString());
    } catch (error) { next(error); }
  };
  readonly callback: RequestHandler = async (req, res, next) => {
    delete req.auth;
    const { oauth, sessions, config, now } = this.options;
    let authorization: Authorization | undefined;
    let committed = false;
    try {
      const state = req.query.state;
      const attempt = sessions.browser(req.browserId)?.attempt;
      if (typeof state !== "string" || !attempt || !same(state, attempt.state) ||
          attempt.expiresAt <= now() || !attempt.active || attempt.claimed) {
        throw new RitaAuthError("invalid_state", 400);
      }
      attempt.claimed = true;
      try {
        if (req.query.error !== undefined) throw new RitaAuthError("access_denied", 400);
        if (typeof req.query.code !== "string" || !req.query.code) throw new RitaAuthError("missing_code", 400);
        try { authorization = await oauth.exchange(req.query.code, attempt.verifier); }
        catch (error) {
          if (error instanceof ProviderError && ["invalid_client", "unauthorized_client", "invalid_scope"].includes(error.code))
            throw new RitaAuthError("integration_error", 502);
          throw new RitaAuthError("authentication_failed", 502);
        }
        if (!attempt.active || attempt.expiresAt <= now() || !sessions.browser(req.browserId) || res.destroyed) {
          throw new RitaAuthError("invalid_state", 400);
        }
        if (!Number.isFinite(authorization.expiresAt) || authorization.expiresAt <= now())
          throw new RitaAuthError("authentication_failed", 502);
        // No await between invalidating the old key and publishing the new one.
        const created = sessions.create(authorization, now() + config.sessionMaxAgeMs, req.browserId);
        committed = true;
        req.browserId = created.id;
        setBrowserCookie(res, config, created.key, created.deadline - now());
        req.auth = { profile: authorization.profile, expiresAt: authorization.expiresAt };
      } finally { attempt.active = false; }
      next();
    } catch (error) {
      if (!committed && authorization?.tokens.refreshToken)
        await oauth.revoke(authorization.tokens.refreshToken).catch(() => undefined);
      next(error);
    }
  };
}
