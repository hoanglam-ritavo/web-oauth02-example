interface CommonConfig {
  port: number; host: string; apiUrl: string; mobile: MobileSettings;
}
export interface MobileSettings {
  enabled: boolean; clientId: string; sessionMaxAgeMs: number; maxSessions: number; maxHandoffs: number;
}
interface BrowserSettings {
  sessionMaxAgeMs: number; appUrl: string; portalUrl: string; clientId: string;
  clientSecret: string; maxSessionEntries: number; callbackUrl: string; secureCookie: boolean;
}
export type WebConfig = CommonConfig & BrowserSettings & { mode: 'web' | 'both' };
export type MobileConfig = CommonConfig & { mode: 'mobile' };
export type Config = WebConfig | MobileConfig;

export function readConfig(env: NodeJS.ProcessEnv): Config {
  if (env.NODE_ENV === "production")
    throw new Error("Demo uses RAM: production is disabled.");
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
      url.username ||
      url.password ||
      url.href.includes("?") ||
      url.href.includes("#")
    ) {
      throw new Error(
        "RITA_API_URL must be an HTTP(S) base URL without credentials, query or fragment.",
      );
    }
    return url.href.replace(/\/+$/, "");
  }

  const legacy = env.MOBILE_AUTH_ENABLED ?? 'false';
  if (env.EXAMPLE_MODE === undefined && !['true', 'false'].includes(legacy))
    throw new Error('MOBILE_AUTH_ENABLED must be true or false.');
  const mode = env.EXAMPLE_MODE ?? (legacy === 'true' ? 'both' : 'web');
  if (mode !== 'web' && mode !== 'mobile' && mode !== 'both')
    throw new Error('EXAMPLE_MODE must be web, mobile or both.');
  const host = env.HOST ?? '127.0.0.1';
  if (!host || !/^[a-zA-Z0-9.:-]+$/.test(host)) throw new Error('HOST must be a hostname or IP address.');
  const hours = (name: string) => {
    const value = Number(env[name] ?? '8');
    if (!Number.isFinite(value) || value <= 0 || value > 24) throw new Error('Invalid ' + name);
    return value * 3_600_000;
  };
  const positive = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid ' + name);
    return value;
  };
  const mobile: MobileSettings = mode === 'web'
    ? { enabled: false, clientId: '', sessionMaxAgeMs: 28_800_000, maxSessions: 1000, maxHandoffs: 2000 }
    : { enabled: true, clientId: secret('RITA_MOBILE_CLIENT_ID'),
        sessionMaxAgeMs: hours('MOBILE_SESSION_MAX_AGE_HOURS'),
        maxSessions: positive('MOBILE_MAX_SESSION_ENTRIES', 1000),
        maxHandoffs: positive('MOBILE_MAX_HANDOFF_ENTRIES', 2000) };
  const common = { host, port, apiUrl: apiBaseUrl(), mobile };
  if (mode === 'mobile') return { ...common, mode };
  const clientId = secret('RITA_CLIENT_ID');
  if (mobile.enabled && mobile.clientId === clientId) throw new Error('Mobile and browser client IDs must differ.');
  const appUrl = origin('APP_BASE_URL', 'http://localhost:3003');
  return { ...common, mode, clientId, clientSecret: secret('RITA_CLIENT_SECRET'),
    appUrl, portalUrl: origin('RITA_PORTAL_URL', 'http://localhost:3000'),
    callbackUrl: appUrl + '/auth/callback', secureCookie: appUrl.startsWith('https:'),
    sessionMaxAgeMs: hours('SESSION_MAX_AGE_HOURS'),
    maxSessionEntries: positive('MAX_SESSION_ENTRIES', 10000) };
}
