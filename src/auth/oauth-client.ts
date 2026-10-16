import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Config } from "../config.js";

import { parseProfile, validSubject, type Profile } from "./profile.js";

export interface Identity {
  profile: Profile;
  expiresAt: number;
}
export interface OAuthClient {
  exchange(code: string, verifier: string): Promise<Identity>;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function createOAuthClient(
  config: Config,
  options: {
    fetch?: typeof fetch;
    key?: JWTVerifyGetKey;
    now?: () => number;
    timeoutMs?: number;
  } = {},
): OAuthClient {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const key =
    options.key ??
    createRemoteJWKSet(new URL(config.apiUrl + "/.well-known/jwks.json"), {
      timeoutDuration: timeoutMs,
    });
  async function json(path: string, init: RequestInit): Promise<unknown> {
    const response = await request(config.apiUrl + path, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Rita ID request failed.");
    return response.json();
  }
  return {
    async exchange(code, verifier) {
      const result = await json("/auth/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          redirect_uri: config.callbackUrl,
          code,
          code_verifier: verifier,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
      });
      if (
        !record(result) ||
        typeof result.access_token !== "string" ||
        result.token_type !== "Bearer"
      ) {
        throw new Error("Invalid token response.");
      }
      // Current Rita ID tokens have no issuer or token_use. Trust is anchored
      // to the configured JWKS origin, signature, audience and userinfo match.
      const { payload } = await jwtVerify(result.access_token, key, {
        algorithms: ["RS256"],
        audience: config.clientId,
        requiredClaims: ["sub", "aud", "exp"],
        currentDate: new Date(now()),
      });
      if (
        !validSubject(payload.sub) ||
        payload.isClient === true ||
        typeof payload.exp !== "number"
      ) {
        throw new Error("Invalid user token.");
      }
      const data = await json("/auth/oauth/userinfo", {
        headers: {
          Authorization: "Bearer " + result.access_token,
          Accept: "application/json",
        },
      });
      const profile = parseProfile(data, payload.sub);
      if (payload.exp * 1000 <= now())
        throw new Error("Token expired during login.");
      // Deliberately discard all credentials after fetching the profile.
      return { profile, expiresAt: payload.exp * 1000 };
    },
  };
}
