export interface Config {
  port: number;
  sessionMaxAgeMs: number;
  appUrl: string;
  portalUrl: string;
  /** HTTP(S) base URL, optionally with a path, without a trailing slash. */
  apiUrl: string;
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  callbackUrl: string;
  secureCookie: boolean;
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  if (env.NODE_ENV === "production")
    throw new Error("Demo uses MemoryStore: production is disabled.");
  const port = Number(env.PORT ?? "3003");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be 1–65535.");
  function origin(key: string, fallback: string): string {
    let url: URL;
    try {
      url = new URL(env[key] ?? fallback);
    } catch {
      throw new Error(key + " must be an absolute HTTP(S) origin.");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error(
        key +
          " must be an HTTP(S) origin without credentials, path, query or fragment.",
      );
    }
    return url.origin;
  }
  function secret(key: string, min = 1): string {
    const value = env[key]?.trim();
    if (
      !value ||
      value.length < min ||
      /^(replace|change-me|placeholder)/i.test(value)
    ) {
      throw new Error(
        key +
          " must be configured with a real value (minimum " +
          min +
          " characters).",
      );
    }
    return value;
  }
  function apiBaseUrl(): string {
    let url: URL;
    try {
      url = new URL(env.RITA_API_URL ?? "http://localhost:3000/api");
    } catch {
      throw new Error("RITA_API_URL must be an absolute HTTP(S) base URL.");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username || url.password || url.href.includes("?") || url.href.includes("#")
    ) {
      throw new Error("RITA_API_URL must be an HTTP(S) base URL without credentials, query or fragment.");
    }
    return url.href.replace(/\/+$/, "");
  }
  const sessionHours = Number(env.SESSION_MAX_AGE_HOURS ?? "8");
  if (!Number.isFinite(sessionHours) || sessionHours <= 0 || sessionHours > 24)
    throw new Error("SESSION_MAX_AGE_HOURS must be greater than 0 and at most 24.");
  const appUrl = origin("APP_BASE_URL", "http://localhost:3003");
  return {
    port,
    sessionMaxAgeMs: sessionHours * 3_600_000,
    appUrl,
    portalUrl: origin("RITA_PORTAL_URL", "http://localhost:3000"),
    apiUrl: apiBaseUrl(),
    clientId: secret("RITA_CLIENT_ID"),
    clientSecret: secret("RITA_CLIENT_SECRET"),
    sessionSecret: secret("SESSION_SECRET", 32),
    callbackUrl: appUrl + "/auth/callback",
    secureCookie: appUrl.startsWith("https:"),
  };
}
