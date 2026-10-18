import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import axios, { type AxiosAdapter } from "axios";
import type { Config } from "../config.js";
import { parseProfile, validSubject, type Profile } from "./profile.js";

// Safe to expose to route handlers. Credentials never belong in this type.
export interface Identity { profile: Profile; expiresAt: number }
export interface TokenSet { accessToken: string; refreshToken?: string; scopes: string[] }
export interface Authorization extends Identity { tokens: TokenSet }
export interface OAuthClient {
  exchange(code: string, verifier: string): Promise<Authorization>;
  refresh(refreshToken: string): Promise<TokenSet>;
  verify(tokens: TokenSet, expectedSubject?: string): Promise<Identity>;
  revoke(refreshToken: string): Promise<void>;
}
export class ProviderError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super("Rita ID request failed.");
  }
}
export class InvalidIdentityError extends Error {
  constructor() { super("Invalid Rita ID identity."); }
}
export class AccessExpiredError extends InvalidIdentityError {}
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function createOAuthClient(config: Config, options: {
  adapter?: AxiosAdapter; key?: JWTVerifyGetKey; now?: () => number; timeoutMs?: number;
} = {}): OAuthClient {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const http = axios.create({ timeout: timeoutMs, maxRedirects: 0,
    responseType: "text", transformResponse: [], validateStatus: () => true,
    ...(options.adapter ? { adapter: options.adapter } : {}),
  });
  const key = options.key ?? createRemoteJWKSet(
    new URL(config.apiUrl + "/.well-known/jwks.json"), { timeoutDuration: timeoutMs, cooldownDuration: 0 },
  );
  async function send(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      const result = await http.request({ url: config.apiUrl + path,
        method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)),
        data: init.body, signal: AbortSignal.timeout(timeoutMs),
      });
      response = new Response(result.status === 204 ? null : result.data, { status: result.status });
    } catch { throw new ProviderError("transport_error", 503); }
    if (!response.ok) {
      const data: unknown = await response.json().catch(() => null);
      const allowed = ["temporarily_unavailable", "invalid_grant", "invalid_client",
        "invalid_scope", "unauthorized_client", "unsupported_grant_type", "invalid_request"];
      const code = record(data) && typeof data.error === "string" && allowed.includes(data.error)
        ? data.error : "upstream_error";
      throw new ProviderError(code, response.status);
    }
    return response;
  }
  const post = (path: string, body: Record<string, string>) => send(path, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ...body, client_id: config.clientId, client_secret: config.clientSecret }),
  });
  async function token(body: Record<string, string>, rotating = false): Promise<TokenSet> {
    const data: unknown = await (await post("/auth/oauth/token", body)).json();
    if (!record(data) || typeof data.access_token !== "string" || !data.access_token ||
        data.token_type !== "Bearer" ||
        (data.refresh_token !== undefined && (typeof data.refresh_token !== "string" || !data.refresh_token)) ||
        (rotating && !data.refresh_token) ||
        (data.scope !== undefined && typeof data.scope !== "string")) {
      throw new Error("Invalid token response.");
    }
    return {
      accessToken: data.access_token, refreshToken: data.refresh_token as string | undefined,
      scopes: typeof data.scope === "string" ? [...new Set(data.scope.split(" ").filter(Boolean))] : [],
    };
  }
  async function verify(tokens: TokenSet, expectedSubject?: string): Promise<Identity> {
    // Token purpose is mandatory; Rita ID still does not provide a complete OIDC issuer contract.
    let payload;
    try {
      ({ payload } = await jwtVerify(tokens.accessToken, async (header, token) => {
        if (typeof header.kid !== "string" || !header.kid) throw new InvalidIdentityError();
        return key(header, token);
      }, {
        algorithms: ["RS256"], audience: config.clientId,
        requiredClaims: ["sub", "aud", "exp", "token_use"], currentDate: new Date(now()),
      }));
    } catch (error) {
      // A JWKS outage is retryable with the SAME new access token, not another rotation.
      const code = (error as { code?: string }).code;
      if (["ERR_JWKS_TIMEOUT", "ERR_JOSE_GENERIC", "ERR_JWKS_INVALID", "ERR_JWK_INVALID"].includes(code ?? "") || error instanceof TypeError) throw error;
      if (code === "ERR_JWT_EXPIRED") {
        const expired = (error as { payload: { sub?: unknown; isClient?: unknown; token_use?: unknown } }).payload;
        if (validSubject(expired.sub) && expired.isClient !== true && expired.token_use === "oauth_access" &&
            (expectedSubject === undefined || expired.sub === expectedSubject)) throw new AccessExpiredError();
      }
      throw new InvalidIdentityError();
    }
    if (!validSubject(payload.sub) || payload.isClient === true || payload.token_use !== "oauth_access" ||
        typeof payload.exp !== "number" ||
        (expectedSubject !== undefined && payload.sub !== expectedSubject)) {
      throw new InvalidIdentityError();
    }
    let data: unknown;
    try {
      data = await (await send("/auth/oauth/userinfo", {
        headers: { Authorization: "Bearer " + tokens.accessToken, Accept: "application/json" },
      })).json();
    } catch (error) {
      if (error instanceof ProviderError && error.status === 401 && payload.exp * 1000 <= now()) {
        throw new AccessExpiredError();
      }
      throw error;
    }
    if (payload.exp * 1000 <= now()) throw new AccessExpiredError();
    try {
      const profile = parseProfile(data, payload.sub);
      if (payload.exp * 1000 <= now()) throw new InvalidIdentityError();
      return { profile, expiresAt: payload.exp * 1000 };
    } catch { throw new InvalidIdentityError(); }
  }
  async function revoke(refreshToken: string) {
    // The endpoint has an empty successful body.
    await post("/auth/oauth/revoke", { token: refreshToken });
  }
  return {
    async exchange(code, verifier) {
      const tokens = await token({
        grant_type: "authorization_code", redirect_uri: config.callbackUrl,
        code, code_verifier: verifier,
      });
      try { return { ...await verify(tokens), tokens }; }
      catch (error) {
        if (tokens.refreshToken) await revoke(tokens.refreshToken).catch(() => undefined);
        throw error;
      }
    },
    refresh: refreshToken => token({ grant_type: "refresh_token", refresh_token: refreshToken }, true),
    verify, revoke,
  };
}
