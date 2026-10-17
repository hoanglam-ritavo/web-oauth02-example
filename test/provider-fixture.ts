import type { AxiosAdapter } from "axios";
import { createOAuthClient as createClient } from "../src/auth/oauth-client.js";

// Adapt existing HTTP provider fixtures to Axios; production always uses its HTTP adapter.
export function createOAuthClient(config: Parameters<typeof createClient>[0], options:
  Parameters<typeof createClient>[1] & { fetch?: typeof fetch } = {}) {
  const { fetch: fetcher, ...rest } = options;
  const adapter: AxiosAdapter | undefined = fetcher && (async config => {
    const response = await fetcher(config.url!, {
      method: config.method?.toUpperCase(), headers: config.headers.toJSON() as Record<string, string>,
      body: config.data, signal: config.signal as AbortSignal, redirect: "error",
    });
    return { data: await response.text(), status: response.status, statusText: response.statusText,
      headers: Object.fromEntries(response.headers), config };
  });
  return createClient(config, { ...rest, ...(adapter ? { adapter } : {}) });
}
