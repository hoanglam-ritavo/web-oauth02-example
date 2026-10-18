import { createHash, randomBytes } from 'node:crypto';
import type { Authorization, Identity, OAuthClient, TokenSet } from "./oauth-client.js";
import { AccessExpiredError, InvalidIdentityError, ProviderError } from "./oauth-client.js";

export class SessionError extends Error {
  constructor(readonly code: string, readonly status: number, readonly retryAfter?: number) {
    super(code);
  }
}
export interface SessionStatus {
  accessExpiresAt: number;
  sessionExpiresAt: number;
  canRefresh: boolean;
  scopes: string[];
  refreshCount: number;
  lastRefreshAt: number | null;
  verificationPending: boolean;
}
export interface LoginAttempt { state: string; verifier: string; expiresAt: number; active: boolean; claimed: boolean }
export interface Entry {
  csrf: string;
  attempt?: LoginAttempt;
  identity?: Identity;
  tokens: TokenSet;
  deadline: number;
  closing: boolean;
  pending: boolean;
  version: number;
  retryAt: number;
  refreshCount: number;
  lastRefreshAt: number | null;
  failure?: SessionError;
  revokeConfirmed?: boolean;
  flight?: Promise<void>;
  closeFlight?: Promise<boolean>;
  timer?: ReturnType<typeof setTimeout>;
}
type AuthEntry = Entry & { identity: Identity };
export const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");
const unauthenticated = () => new SessionError("not_authenticated", 401);

/** One process only. The cookie references this store directly; no secondary session store. */
export class OAuthSessions {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly oauth: OAuthClient, private readonly now = Date.now, private readonly capacity = 10_000) {}

  browser(id: string | undefined): Entry | undefined {
    const entry = id ? this.entries.get(id) : undefined;
    if (!entry || entry.closing) return undefined;
    if (entry.deadline <= this.now()) { void this.close(id!); return undefined; }
    return entry;
  }

  create(authorization?: Authorization, deadline = this.now() + 600_000, replacing?: string) {
    if (this.entries.size >= this.capacity && !(replacing && this.browser(replacing))) {
      throw new SessionError("store_full", 503, 5);
    }
    const key = randomBytes(32).toString("base64url");
    const id = keyHash(key);
    if (replacing) {
      void this.close(replacing);
      this.entries.delete(replacing);
    }
    const effectiveDeadline = this.add(id, authorization, deadline);
    return { key, id, deadline: effectiveDeadline };
  }

  add(id: string, authorization: Authorization | undefined, deadline: number) {
    const effectiveDeadline = !authorization || authorization.tokens.refreshToken
      ? deadline : Math.min(deadline, authorization.expiresAt);
    const entry: Entry = {
      csrf: randomBytes(32).toString("base64url"),
      identity: authorization ? { profile: authorization.profile, expiresAt: authorization.expiresAt } : undefined,
      tokens: authorization?.tokens ?? { accessToken: "", scopes: [] }, deadline: effectiveDeadline, closing: false,
      pending: false, version: 0, retryAt: 0, refreshCount: 0, lastRefreshAt: null,
    };
    this.entries.set(id, entry);
    // Cleanup only, never background refresh. Expire even if the browser stops visiting.
    entry.timer = setTimeout(() => { void this.close(id); }, Math.max(0, effectiveDeadline - this.now()));
    entry.timer.unref();
    return effectiveDeadline;
  }

  private async entry(id: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.closing) throw unauthenticated();
    if (entry.deadline <= this.now()) {
      await this.close(id);
      throw unauthenticated();
    }
    if (!entry.identity) throw unauthenticated();
    return entry as AuthEntry;
  }

  async status(id: string): Promise<SessionStatus> {
    const e = await this.entry(id);
    if (e.failure) throw e.failure;
    return this.snapshot(e);
  }
  private snapshot(e: AuthEntry): SessionStatus {
    return {
      accessExpiresAt: e.identity.expiresAt, sessionExpiresAt: e.deadline,
      canRefresh: Boolean(e.tokens.refreshToken), scopes: [...e.tokens.scopes],
      refreshCount: e.refreshCount, lastRefreshAt: e.lastRefreshAt,
      verificationPending: e.pending,
    };
  }

  async resolve(id: string, force = false): Promise<Identity> {
    const e = await this.entry(id);
    const version = e.version;
    if (e.failure) throw e.failure;
    let updated = false;
    const update = async () => {
      if (e.closing || e.deadline <= this.now()) throw unauthenticated();
      if (e.failure) throw e.failure;
      if (e.flight) { await e.flight; return; }
      if (e.version !== version && !e.pending) return;
      if (!e.pending && !e.tokens.refreshToken) throw unauthenticated();
      if (e.retryAt > this.now()) {
        throw new SessionError("temporarily_unavailable", 503, Math.ceil((e.retryAt - this.now()) / 1000));
      }
      e.flight = this.update(e);
      try { await e.flight; updated = true; } finally { e.flight = undefined; }
    };
    if (e.flight) await e.flight;
    else if (force && !e.tokens.refreshToken && !e.pending) {
      throw new SessionError("refresh_unavailable", 409);
    }
    else if (e.pending || force) await update();
    try {
      if (e.failure) throw e.failure;
      if (!updated) {
        if (e.retryAt > this.now()) throw new SessionError("temporarily_unavailable", 503,
          Math.ceil((e.retryAt - this.now()) / 1000));
        let identity: Identity;
        // A manual rotation may finish while this request is waiting on userinfo.
        // Never commit an identity or failure obtained with superseded credentials.
        const verifyCurrent = async (): Promise<Identity> => {
          for (let attempt = 0; attempt < 2; attempt++) {
            if (e.flight) await e.flight;
            if (e.closing) throw unauthenticated();
            if (e.failure) throw e.failure;
            const currentVersion = e.version;
            try {
              const result = await this.oauth.verify(e.tokens, e.identity.profile.sub);
              if (e.flight || e.version !== currentVersion) continue;
              return result;
            } catch (error) {
              if (e.flight || e.version !== currentVersion) continue;
              throw error;
            }
          }
          throw new SessionError("temporarily_unavailable", 503, 1);
        };
        try { identity = await verifyCurrent(); }
        catch (error) {
          if (!(error instanceof AccessExpiredError)) throw error;
          await update();
          identity = updated ? e.identity : await verifyCurrent();
        }
        if (identity.profile.sub !== e.identity.profile.sub || !Number.isFinite(identity.expiresAt) ||
            identity.expiresAt <= this.now()) throw new InvalidIdentityError();
        if (!e.closing) e.identity = identity;
      }
    } catch (error) {
      if (error instanceof SessionError) throw error;
      if (error instanceof ProviderError && error.status === 403) throw new SessionError("forbidden", 403);
      if (error instanceof InvalidIdentityError ||
          (error instanceof ProviderError && [400, 401].includes(error.status))) {
        e.failure = unauthenticated();
        await this.discard(e);
        throw e.failure;
      }
      e.retryAt = this.now() + 5_000;
      throw new SessionError("temporarily_unavailable", 503, 5);
    }
    if (e.closing || e.deadline <= this.now() || e.identity.expiresAt <= this.now()) {
      if (!e.closing) await this.close(id);
      throw unauthenticated();
    }
    if (e.failure) throw e.failure;
    return { profile: e.identity.profile, expiresAt: e.identity.expiresAt };
  }

  private async update(e: AuthEntry) {
    if (!e.pending) {
      try {
        // Commit replacement credentials BEFORE any JWT/userinfo await.
        e.tokens = await this.oauth.refresh(e.tokens.refreshToken!);
        e.version++;
        e.pending = true;
      } catch (error) {
        if (error instanceof ProviderError && error.status === 503 && error.code === "temporarily_unavailable") {
          e.retryAt = this.now() + 5_000;
          throw new SessionError("temporarily_unavailable", 503, 5);
        }
        const configurationError = error instanceof ProviderError &&
          ["invalid_client", "invalid_scope", "unauthorized_client", "unsupported_grant_type", "invalid_request"].includes(error.code);
        e.failure = configurationError
          ? new SessionError("integration_error", 502) : unauthenticated();
        await this.discard(e);
        throw e.failure;
      }
    }
    if (e.closing) return; // close() will revoke the latest replacement.
    try {
      const identity = await this.oauth.verify(e.tokens, e.identity.profile.sub);
      if (identity.profile.sub !== e.identity.profile.sub ||
          !Number.isFinite(identity.expiresAt) || identity.expiresAt <= this.now()) {
        throw new InvalidIdentityError();
      }
      if (e.closing) return;
      e.identity = identity;
      e.pending = false;
      e.retryAt = 0;
      e.refreshCount++;
      e.lastRefreshAt = this.now();
    } catch (error) {
      if (error instanceof ProviderError && error.status === 403) throw new SessionError("forbidden", 403);
      if (error instanceof InvalidIdentityError ||
          (error instanceof ProviderError && [400, 401].includes(error.status))) {
        e.failure = unauthenticated();
        await this.discard(e);
        throw e.failure;
      }
      // Keep replacement credentials; retry verification, NOT the refresh grant.
      e.retryAt = this.now() + 5_000;
      throw new SessionError("temporarily_unavailable", 503, 5);
    }
  }

  private async discard(e: Entry): Promise<boolean> {
    const token = e.tokens.refreshToken;
    e.tokens = { accessToken: "", scopes: [] };
    if (!token) return e.revokeConfirmed ?? true;
    try { await this.oauth.revoke(token); e.revokeConfirmed = true; }
    catch { e.revokeConfirmed = false; }
    return e.revokeConfirmed;
  }

  close(id: string): Promise<boolean> {
    const e = this.entries.get(id);
    if (!e) return Promise.resolve(true);
    if (e.closeFlight) return e.closeFlight;
    e.closing = true;
    if (e.attempt) e.attempt.active = false;
    clearTimeout(e.timer);
    e.closeFlight = (async () => {
      await e.flight?.catch(() => undefined);
      const revoked = await this.discard(e);
      this.entries.delete(id);
      return revoked;
    })();
    return e.closeFlight;
  }
}
