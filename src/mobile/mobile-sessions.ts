import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import { InvalidIdentityError, ProviderError, type MobileOAuthClient, type TokenSet, type VerifiedProof } from '../auth/oauth-client.js';
import { OAuthSessions, SessionError, keyHash } from '../auth/oauth-sessions.js';
import type { Profile } from '../auth/profile.js';

export interface Handoff { handoffId: string; clientId: string; accessToken: string; refreshToken: string }
export interface MobileResponse { sessionKey: string; expiresAt: string; profile: Profile }
interface Sealed { iv: Buffer; tag: Buffer; data: Buffer }
interface Transfer {
  fingerprint: string; refreshFingerprint: string; reservation: string;
  deadline: number; retainUntil: number; retryAt: number;
  original?: VerifiedProof; replacement?: TokenSet;
  sessionId?: string; sealed?: Sealed; failure?: SessionError;
  flight?: Promise<MobileResponse>; timer?: ReturnType<typeof setTimeout>; cleanup?: ReturnType<typeof setTimeout>;
}
const denied = () => new SessionError('not_authenticated', 401);
const temporary = () => new SessionError('temporarily_unavailable', 503, 5);
const sameScopes = (a: string[], b: string[]) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
export class MobileSessions {
  private readonly records = new Map<string, Transfer>();
  private readonly refreshOwners = new Map<string, string>();
  private readonly secret = randomBytes(32);
  private readonly encryptionKey = randomBytes(32);
  readonly sessions: OAuthSessions;
  constructor(private readonly config: Config['mobile'], private readonly oauth: MobileOAuthClient, private readonly now = Date.now) {
    this.sessions = new OAuthSessions(oauth, now, config.maxSessions);
  }
  private hash(value: string) { return createHmac('sha256', this.secret).update(value).digest('hex'); }
  private seal(value: MobileResponse): Sealed {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { iv, data, tag: cipher.getAuthTag() };
  }
  private unseal(value: Sealed): MobileResponse {
    const cipher = createDecipheriv('aes-256-gcm', this.encryptionKey, value.iv);
    cipher.setAuthTag(value.tag);
    return JSON.parse(Buffer.concat([cipher.update(value.data), cipher.final()]).toString('utf8')) as MobileResponse;
  }
  private async abandon(record: Transfer) {
    record.failure ??= denied();
    record.sealed = undefined;
    record.original = undefined;
    const replacement = record.replacement;
    record.replacement = undefined;
    await Promise.all([
      this.sessions.close(record.reservation),
      replacement?.refreshToken ? this.oauth.revoke(replacement.refreshToken).catch(() => undefined) : Promise.resolve(),
    ]);
  }
  private check(record: Transfer) {
    if (record.failure) throw record.failure;
    if (this.now() >= record.deadline) {
      void this.abandon(record);
      throw denied();
    }
  }
  private schedule(record: Transfer, id: string) {
    record.timer = setTimeout(() => {
      if (record.sessionId) record.sealed = undefined;
      else void this.abandon(record);
    }, Math.max(0, record.deadline - this.now()));
    record.timer.unref();
    record.cleanup = setTimeout(() => {
      record.sealed = undefined;
      this.records.delete(id);
      this.refreshOwners.delete(record.refreshFingerprint);
    }, Math.max(0, record.retainUntil - this.now()));
    record.cleanup.unref();
  }
  async handoff(input: Handoff): Promise<MobileResponse> {
    const fingerprint = this.hash(JSON.stringify([input.clientId, input.accessToken, input.refreshToken]));
    let record = this.records.get(input.handoffId);
    if (record) {
      if (record.fingerprint !== fingerprint) throw new SessionError('handoff_conflict', 409);
      if (record.failure) throw record.failure;
      if (record.sessionId) {
        if (!record.sealed || this.now() >= record.deadline || !this.sessions.browser(record.sessionId)?.identity) throw denied();
        await this.sessions.status(record.sessionId);
        // Logout can invalidate the session while status is awaited.
        const live = this.sessions.browser(record.sessionId);
        if (!record.sealed || !live?.identity || live.failure) throw denied();
        return this.unseal(record.sealed);
      }
      this.check(record);
      if (record.flight) return record.flight;
      if (record.retryAt > this.now()) throw temporary();
    } else {
      const refreshFingerprint = this.hash(JSON.stringify([input.clientId, input.refreshToken]));
      if (this.refreshOwners.has(refreshFingerprint)) throw new SessionError('handoff_conflict', 409);
      if (this.records.size >= this.config.maxHandoffs) throw new SessionError('store_full', 503, 5);
      const deadline = this.now() + 150_000;
      const reservation = this.sessions.create(undefined, deadline).id;
      record = { fingerprint, refreshFingerprint, reservation, deadline,
        retainUntil: deadline + this.config.sessionMaxAgeMs, retryAt: 0 };
      this.records.set(input.handoffId, record);
      this.refreshOwners.set(refreshFingerprint, input.handoffId);
      this.schedule(record, input.handoffId);
    }
    const current = record;
    current.flight = this.accept(current, input);
    try { return await current.flight; } finally { current.flight = undefined; }
  }
  private async accept(record: Transfer, input: Handoff): Promise<MobileResponse> {
    try {
      this.check(record);
      if (!record.replacement) {
        record.original = await this.oauth.proof({ accessToken: input.accessToken, scopes: [] });
        this.check(record);
        if (!['openid', 'profile', 'email'].every(scope => record.original!.scopes.includes(scope))) throw new InvalidIdentityError();
        try { record.replacement = await this.oauth.refresh(input.refreshToken); }
        catch (error) {
          if (error instanceof ProviderError && error.status === 503 && error.code === 'temporarily_unavailable') throw temporary();
          const configuration = error instanceof ProviderError && ['invalid_client', 'unauthorized_client', 'invalid_scope', 'unsupported_grant_type', 'invalid_request'].includes(error.code);
          record.failure = configuration ? new SessionError('integration_error', 502) : denied();
          throw record.failure;
        }
        // A deadline may have elapsed while refresh was in flight; cleanup owns the newly known pair.
        this.check(record);
      }
      const replacement = record.replacement;
      const proof = await this.oauth.proof(replacement, record.original!.profile.sub);
      this.check(record);
      if (proof.profile.sub !== record.original!.profile.sub || !sameScopes(proof.scopes, record.original!.scopes) ||
          !sameScopes(replacement.scopes, proof.scopes) || !replacement.refreshToken || proof.expiresAt <= this.now()) throw new InvalidIdentityError();
      const created = this.sessions.create({ profile: proof.profile, expiresAt: proof.expiresAt, tokens: replacement },
        this.now() + this.config.sessionMaxAgeMs, record.reservation);
      record.replacement = undefined; // Ownership passes to the established session store.
      record.original = undefined;
      record.sessionId = created.id;
      record.deadline = this.now() + 150_000;
      record.retainUntil = Math.max(created.deadline, record.deadline);
      const response = { sessionKey: created.key, expiresAt: new Date(created.deadline).toISOString(), profile: proof.profile };
      record.sealed = this.seal(response);
      clearTimeout(record.timer); clearTimeout(record.cleanup);
      this.schedule(record, input.handoffId);
      return response;
    } catch (error) {
      if (record.failure) { await this.abandon(record); throw record.failure; }
      if (error instanceof SessionError && error.status === 503) {
        record.retryAt = this.now() + 5_000; throw error;
      }
      if (error instanceof InvalidIdentityError || error instanceof ProviderError && [400, 401, 403].includes(error.status)) {
        record.failure = error instanceof ProviderError && error.status === 403 ? new SessionError('forbidden', 403) : denied();
        await this.abandon(record); throw record.failure;
      }
      record.retryAt = this.now() + 5_000;
      throw temporary();
    }
  }
  async resolve(key: string) {
    const id = keyHash(key);
    const identity = await this.sessions.resolve(id);
    const status = await this.sessions.status(id);
    return { profile: identity.profile, expiresAt: new Date(status.sessionExpiresAt).toISOString() };
  }
  async logout(key: string) {
    const id = keyHash(key);
    if (!this.sessions.browser(id)?.identity) throw denied();
    for (const record of this.records.values()) if (record.sessionId === id) {
      record.sealed = undefined; record.failure = denied();
    }
    return { loggedOut: true as const, revokeConfirmed: await this.sessions.close(id) };
  }
  async dispose() {
    const work: Promise<unknown>[] = [];
    for (const record of this.records.values()) {
      clearTimeout(record.timer); clearTimeout(record.cleanup);
      record.failure = denied(); record.sealed = undefined;
      work.push((async () => {
        await record.flight?.catch(() => undefined);
        await this.abandon(record);
        if (record.sessionId) await this.sessions.close(record.sessionId);
      })());
    }
    await Promise.all(work);
    this.records.clear(); this.refreshOwners.clear();
  }
}
