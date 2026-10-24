import express from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT, jwtVerify } from 'jose';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createOAuthClient } from '../src/auth/oauth-client.js';
import { MobileSessions } from '../src/mobile/mobile-sessions.js';
import { profileFields } from './profile-fixture.js';
export async function mobileProvider(mode: "mobile" | "both" = "mobile") {
  const keys = await generateKeyPair('RS256');
  let time = Math.floor(Date.now() / 1000) * 1000;
  const subject = '12345678-1234-4123-8123-123456789012';
  const calls: { path: string; body: Record<string, string> }[] = [];
  let refreshes = 0; let sequence = 0;
  const tokens = new Map<string, { sub: string; scope: string; used: boolean }>();
  const revoked = new Set<string>();
  const state = { userinfoStatus: 200, jwksStatus: 200, refreshSubject: '', refreshScope: '', loseRefreshResponse: false };
  async function sign(overrides: Record<string, unknown> = {}, wrongKey = false) {
    const signing = wrongKey ? await generateKeyPair('RS256') : keys;
    return new SignJWT({ sub: subject, aud: 'mobile', exp: Math.floor(time / 1000) + 300,
      token_use: 'oauth_access', scope: 'openid profile email', ...overrides })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).sign(signing.privateKey);
  }
  async function issue(sub = subject, scope = 'openid profile email') {
    const refreshToken = 'refresh-' + (++sequence);
    tokens.set(refreshToken, { sub, scope, used: false });
    return { accessToken: await sign({ sub, scope }), refreshToken };
  }
  const provider = express(); provider.use(express.json());
  provider.get('/.well-known/jwks.json', (_req, res) => {
    if (state.jwksStatus !== 200) { res.status(state.jwksStatus).json({ error: 'unavailable' }); return; }
    void exportJWK(keys.publicKey).then(jwk => res.json({ keys: [{ ...jwk, kid: 'fixture', alg: 'RS256' }] }));
  });
  provider.post('/auth/oauth/token', async (req, res) => {
    calls.push({ path: req.path, body: req.body }); refreshes++;
    if (req.body.client_id !== 'mobile' || 'client_secret' in req.body || req.body.grant_type !== 'refresh_token') {
      res.status(401).json({ error: 'invalid_client' }); return;
    }
    const record = tokens.get(req.body.refresh_token);
    if (!record || record.used || revoked.has(req.body.refresh_token)) { res.status(400).json({ error: 'invalid_grant' }); return; }
    record.used = true;
    const sub = state.refreshSubject || record.sub; const scope = state.refreshScope || record.scope;
    const pair = await issue(sub, scope);
    if (state.loseRefreshResponse) { req.socket.destroy(); return; }
    res.json({ access_token: pair.accessToken, refresh_token: pair.refreshToken, scope, token_type: 'Bearer', expires_in: 300 });
  });
  provider.get('/auth/oauth/userinfo', async (req, res) => {
    if (state.userinfoStatus !== 200) { res.status(state.userinfoStatus).json({ error: 'unavailable' }); return; }
    try {
      const { payload } = await jwtVerify((req.headers.authorization ?? '').slice(7), keys.publicKey, { currentDate: new Date(time) });
      res.json({ _id: payload.sub, name: 'Fixture User', email: 'fixture@example.invalid', employee_id: null,
        phone_number: null, is_developer: false, groups: 'EMPLOYEE', ...profileFields() });
    } catch { res.status(401).json({ error: 'invalid_token' }); }
  });
  provider.post('/auth/oauth/revoke', (req, res) => { calls.push({ path: req.path, body: req.body }); revoked.add(req.body.token); res.status(200).end(); });
  const providerServer = provider.listen(0, '127.0.0.1'); await once(providerServer, 'listening');
  const origin = (server: Server) => `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config = readConfig({ EXAMPLE_MODE: mode, ...(mode === 'both' ? { RITA_CLIENT_ID: 'browser', RITA_CLIENT_SECRET: 'browser-secret' } : {}), RITA_API_URL: origin(providerServer),
    RITA_MOBILE_CLIENT_ID: 'mobile' });
  const oauth = createOAuthClient(config, { publicClientId: 'mobile', now: () => time });
  const sessions = new MobileSessions(config.mobile, oauth, () => time);
  const server = createApp(config, { mobileSessions: sessions, now: () => time }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { origin: origin(server), sessions, state, subject, calls, sign, issue,
    refreshes: () => refreshes, advance: (ms: number) => { time += ms; },
    handoff: async () => ({ ...await issue(), handoffId: 'a'.repeat(64), clientId: 'mobile' }),
    close: async () => {
      await sessions.dispose();
      await Promise.all([server, providerServer].map(s => new Promise<void>((resolve, reject) => s.close(e => e ? reject(e) : resolve()))));
    },
  };
}
