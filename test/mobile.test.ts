import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { MobileSessions } from '../src/mobile/mobile-sessions.js';
import { AccessExpiredError, InvalidIdentityError, ProviderError, type MobileOAuthClient, type TokenSet } from '../src/auth/oauth-client.js';
import { SessionError } from '../src/auth/oauth-sessions.js';
import { profileFields } from './profile-fixture.js';
const base = { RITA_CLIENT_ID: 'browser', RITA_CLIENT_SECRET: 'browser-secret', MOBILE_AUTH_ENABLED: 'true', RITA_MOBILE_CLIENT_ID: 'mobile' };
const profile = { sub: '12345678-1234-4123-8123-123456789012', name: 'Test', email: 'test@example.invalid', employee_id: null, phone_number: null,
  is_developer: false, groups: 'EMPLOYEE' as const, ...profileFields() };
const scopes = ['email', 'openid', 'profile'];
const input = () => ({ handoffId: 'a'.repeat(64), clientId: 'mobile', accessToken: 'original-access', refreshToken: 'original-refresh' });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t: TestContext, env = {}) {
  let time = Date.now(); const config = readConfig({ ...base, ...env });
  assert.notEqual(config.mode, "mobile");
  if (config.mode === "mobile") throw new Error("Expected both mode");
  const calls = { refresh: 0, proofs: [] as string[], revoke: [] as string[] };
  const identity = () => ({ profile, expiresAt: time + 300_000 });
  const oauth: MobileOAuthClient = {
    exchange: async () => ({ ...identity(), tokens: { accessToken: 'browser-access', refreshToken: 'browser-refresh', scopes } }),
    proof: async tokens => { calls.proofs.push(tokens.accessToken); return { ...identity(), scopes }; },
    verify: async () => identity(),
    refresh: async () => { calls.refresh++; return { accessToken: 'replacement-access', refreshToken: 'replacement-refresh', scopes }; },
    revoke: async token => { calls.revoke.push(token); },
  };
  const sessions = new MobileSessions(config.mobile, oauth, () => time);
  t.after(() => sessions.dispose());
  const app = createApp(config, { oauth, mobileSessions: sessions, now: () => time });
  return { config, sessions, oauth, app, calls, advance: (ms: number) => { time += ms; } };
}
const status = (code: number) => (e: unknown) => e instanceof SessionError && e.status === code;
test('mobile config defaults, strict flags, public ID and host', () => {
  const config = readConfig({ RITA_CLIENT_ID: 'browser', RITA_CLIENT_SECRET: 'secret' });
  assert.equal(config.mobile.enabled, false); assert.equal(config.host, '127.0.0.1'); assert.equal(config.mobile.sessionMaxAgeMs, 28_800_000);
  for (const env of [{ MOBILE_AUTH_ENABLED: 'yes' }, { RITA_MOBILE_CLIENT_ID: 'browser' }, { RITA_MOBILE_CLIENT_ID: '' },
    { MOBILE_MAX_SESSION_ENTRIES: '0' }, { MOBILE_MAX_HANDOFF_ENTRIES: '-1' }, { MOBILE_SESSION_MAX_AGE_HOURS: '25' }, { HOST: 'http://bad' }, { NODE_ENV: 'production' }]) assert.throws(() => readConfig({ ...base, ...env }));
  assert.equal(readConfig({ ...base, HOST: '0.0.0.0' }).host, '0.0.0.0');
});
test('HTTP handoff profile, stable encrypted replay, private API and logout contract', async t => {
  const f = fixture(t);
  const first = await request(f.app).post('/api/mobile/auth/session').send(input()).expect(200);
  assert.deepEqual(Object.keys(first.body).sort(), ['expiresAt', 'profile', 'sessionKey']);
  assert.match(first.body.sessionKey, /^[\w-]{43}$/); assert.equal(first.body.profile.sub, profile.sub);
  assert.equal(first.headers['set-cookie'], undefined); assert.equal(first.headers['cache-control'], 'no-store');
  assert.doesNotMatch(first.text, /original-|replacement-|csrf/);
  const replay = await request(f.app).post('/api/mobile/auth/session').send(input()).expect(200);
  assert.deepEqual(replay.body, first.body); assert.equal(f.calls.refresh, 1);
  const auth = `Bearer ${first.body.sessionKey}`;
  await request(f.app).get('/api/mobile/me').set('Authorization', auth).expect(200, { profile, expiresAt: first.body.expiresAt });
  await request(f.app).get('/api/mobile/private/example').set('Authorization', auth).expect(200, { message: 'Private resource accessed.', subject: profile.sub });
  await request(f.app).post('/api/mobile/auth/logout').set('Authorization', auth).expect(200, { loggedOut: true, revokeConfirmed: true });
  await request(f.app).get('/api/mobile/me').set('Authorization', auth).expect(401);
  await request(f.app).post('/api/mobile/auth/session').send(input()).expect(401);
  assert.deepEqual(f.calls.revoke, ['replacement-refresh']);
});
test('browser continues login/CSRF/logout with mobile enabled, credentials never cross stores', async t => {
  const f = fixture(t); const browser = request.agent(f.app);
  const login = await browser.get('/auth/login');
  await browser.get('/auth/callback').query({ code: 'code', state: new URL(login.headers.location!).searchParams.get('state') }).expect(302);
  const meta = await browser.get('/api/session'); await browser.get('/api/me').expect(200);
  const mobile = await f.sessions.handoff(input());
  await request(f.app).get('/api/me').set('Cookie', `rita_example.key=${mobile.sessionKey}`).expect(401);
  const cookie = String(login.headers['set-cookie']).split(';')[0]!.split('=')[1]!;
  await request(f.app).get('/api/mobile/me').set('Authorization', `Bearer ${cookie}`).expect(401);
  const denied = await browser.get('/api/mobile/me').expect(401); assert.equal(denied.headers['set-cookie'], undefined);
  await browser.get('/api/me').expect(200);
  await browser.post('/auth/logout').send({}).expect(403);
  await browser.post('/auth/logout').send({ csrf: meta.body.csrf }).expect(200);
  await f.sessions.resolve(mobile.sessionKey);
});
test('mobile routing rejects Origin, bad bodies, duplicate auth and unknown paths without cookies', async t => {
  const f = fixture(t);
  for (const body of [{}, { ...input(), extra: 1 }, { ...input(), handoffId: 'z'.repeat(64) }, { ...input(), accessToken: 'a b' }]) await request(f.app).post('/api/mobile/auth/session').send(body).expect(400);
  await request(f.app).post('/api/mobile/auth/session').send({ ...input(), clientId: 'browser' }).expect(403);
  await request(f.app).post('/api/mobile/auth/session').set('Origin', f.config.appUrl).send(input()).expect(403);
  await request(f.app).post('/api/mobile/auth/session').send({ ...input(), accessToken: 'a'.repeat(17000) }).expect(413);
  await request(f.app).post('/api/mobile/auth/session').set('Content-Type', 'application/json').send('{').expect(400);
  await request(f.app).post('/api/mobile/auth/session').type('form').send(input()).expect(400);
  await request(f.app).get('/api/mobile/me').set({ Authorization: ['Bearer ' + 'a'.repeat(43), 'Bearer ' + 'b'.repeat(43)] }).expect(401);
  await request(f.app).post('/api/mobile/auth/logout').send({}).expect(400);
  for (const path of ['/api/mobile/missing', '/api/mobile/auth/callback']) {
    const res = await request(f.app).get(path).set('Cookie', 'rita_example.sid=legacy').expect(404);
    assert.equal(res.headers['set-cookie'], undefined); assert.equal(res.headers['access-control-allow-origin'], undefined);
  }
  const disabled = createApp(readConfig({ RITA_CLIENT_ID: 'b', RITA_CLIENT_SECRET: 's' }));
  await request(disabled).get('/api/mobile/me').expect(404);
  await request(disabled).get('/api/session').expect(200);
});
test('concurrent handoffs share one rotation, conflicts never rotate', async t => {
  const f = fixture(t); const gate = deferred<TokenSet>();
  f.oauth.refresh = async () => { f.calls.refresh++; return gate.promise; };
  const first = f.sessions.handoff(input()); const second = f.sessions.handoff(input());
  await new Promise(r => setImmediate(r));
  await assert.rejects(f.sessions.handoff({ ...input(), accessToken: 'other' }), status(409));
  await assert.rejects(f.sessions.handoff({ ...input(), handoffId: 'b'.repeat(64) }), status(409));
  gate.resolve({ accessToken: 'new', refreshToken: 'new-r', scopes });
  assert.deepEqual(await first, await second); assert.equal(f.calls.refresh, 1);
});
for (const stage of ['before', 'after']) test(`temporary proof failure ${stage} refresh retries only necessary stage`, async t => {
  const f = fixture(t); const original = f.oauth.proof; let fail = true;
  f.oauth.proof = async (tokens, sub) => {
    if (fail && (stage === 'before' || tokens.accessToken === 'replacement-access')) throw new ProviderError('transport_error', 503);
    return original(tokens, sub);
  };
  await assert.rejects(f.sessions.handoff(input()), status(503));
  assert.equal(f.calls.refresh, stage === 'before' ? 0 : 1);
  fail = false; f.advance(5001); await f.sessions.handoff(input()); assert.equal(f.calls.refresh, 1);
});
for (const failure of [new ProviderError('transport_error', 503), new Error('malformed'), new ProviderError('upstream_error', 500)]) test(`ambiguous rotation ${failure.message} is terminal`, async t => {
  const f = fixture(t); f.oauth.refresh = async () => { f.calls.refresh++; throw failure; };
  await assert.rejects(f.sessions.handoff(input()), status(401)); f.advance(6000);
  await assert.rejects(f.sessions.handoff(input()), status(401)); assert.equal(f.calls.refresh, 1);
});
test('explicit preconsumption failure retries, configuration failures remain terminal 502', async t => {
  const f = fixture(t); const original = f.oauth.refresh;
  f.oauth.refresh = async () => { throw new ProviderError('temporarily_unavailable', 503); };
  await assert.rejects(f.sessions.handoff(input()), status(503)); f.advance(5001);
  f.oauth.refresh = original; await f.sessions.handoff(input());
  const g = fixture(t); g.oauth.refresh = async () => { throw new ProviderError('invalid_client', 401); };
  await assert.rejects(g.sessions.handoff(input()), status(502)); await assert.rejects(g.sessions.handoff(input()), status(502));
});
for (const mismatch of ['subject', 'scope', 'missing-scope']) test(`handoff rejects ${mismatch} before issuing X`, async t => {
  const f = fixture(t); const original = f.oauth.proof;
  f.oauth.proof = async (tokens, sub) => {
    const proof = await original(tokens, sub);
    if (mismatch === 'missing-scope') return { ...proof, scopes: ['openid'] };
    if (tokens.accessToken === 'replacement-access') return mismatch === 'subject'
      ? { ...proof, profile: { ...proof.profile, sub: '22345678-1234-4123-8123-123456789012' } } : { ...proof, scopes: ['openid'] };
    return proof;
  };
  await assert.rejects(f.sessions.handoff(input()), status(401));
  assert.equal(f.calls.refresh, mismatch === 'missing-scope' ? 0 : 1);
});
test('replay expiry does not kill live X; X absolute expiry is enforced', async t => {
  const f = fixture(t); const result = await f.sessions.handoff(input());
  f.advance(150001); await assert.rejects(f.sessions.handoff(input()), status(401)); await f.sessions.resolve(result.sessionKey);
  f.advance(28_800_000); await assert.rejects(f.sessions.resolve(result.sessionKey), status(401));
});
test('capacity reservations precede refresh and handoff tombstones remain bounded', async t => {
  const f = fixture(t, { MOBILE_MAX_SESSION_ENTRIES: '1', MOBILE_MAX_HANDOFF_ENTRIES: '2' });
  await f.sessions.handoff(input());
  await assert.rejects(f.sessions.handoff({ ...input(), handoffId: 'b'.repeat(64), refreshToken: 'other' }), status(503)); assert.equal(f.calls.refresh, 1);
  const g = fixture(t, { MOBILE_MAX_HANDOFF_ENTRIES: '1' }); g.oauth.proof = async () => { throw new InvalidIdentityError(); };
  await assert.rejects(g.sessions.handoff(input()), status(401));
  await assert.rejects(g.sessions.handoff({ ...input(), handoffId: 'c'.repeat(64), refreshToken: 'third' }), status(503));
});
test('deadline during rotation revokes late replacement and never creates X', async t => {
  const f = fixture(t); const original = f.oauth.refresh;
  f.oauth.refresh = async token => { const result = await original(token); f.advance(150001); return result; };
  await assert.rejects(f.sessions.handoff(input()), status(401)); assert.deepEqual(f.calls.revoke, ['replacement-refresh']);
});
test('logout revocation failure still invalidates X and replay', async t => {
  const f = fixture(t); const result = await f.sessions.handoff(input());
  f.oauth.revoke = async () => { throw new Error('network'); };
  assert.equal((await f.sessions.logout(result.sessionKey)).revokeConfirmed, false);
  await assert.rejects(f.sessions.resolve(result.sessionKey), status(401)); await assert.rejects(f.sessions.handoff(input()), status(401));
});

test('mobile logout during shared refresh waits and revokes the newest credential', async t => {
  const f = fixture(t); const result = await f.sessions.handoff(input());
  f.oauth.verify = async () => { throw new AccessExpiredError(); };
  const gate = deferred<TokenSet>();
  f.oauth.refresh = async () => { f.calls.refresh++; return gate.promise; };
  const first = f.sessions.resolve(result.sessionKey); const firstRejected = assert.rejects(first, status(401));
  const second = f.sessions.resolve(result.sessionKey); const secondRejected = assert.rejects(second, status(401));
  await new Promise(r => setImmediate(r));
  const closing = f.sessions.logout(result.sessionKey);
  await assert.rejects(f.sessions.handoff(input()), status(401));
  gate.resolve({ accessToken: 'latest-a', refreshToken: 'latest-r', scopes });
  assert.equal((await closing).revokeConfirmed, true); await Promise.all([firstRejected, secondRejected]);
  assert.equal(f.calls.refresh, 2); assert.deepEqual(f.calls.revoke, ['latest-r']);
});
test('timer expires unfinished handoff and later frees bounded tombstone capacity', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { MOBILE_MAX_HANDOFF_ENTRIES: '1', MOBILE_SESSION_MAX_AGE_HOURS: '0.001' });
  const proof = f.oauth.proof;
  f.oauth.proof = async tokens => { if (tokens.accessToken === 'replacement-access') throw new ProviderError('transport_error', 503); return proof(tokens); };
  await assert.rejects(f.sessions.handoff(input()), status(503));
  f.advance(150001); t.mock.timers.tick(150001); await new Promise(r => setImmediate(r));
  assert.deepEqual(f.calls.revoke, ['replacement-refresh']);
  await assert.rejects(f.sessions.handoff(input()), status(401));
  f.advance(3601); t.mock.timers.tick(3601); f.oauth.proof = proof;
  await f.sessions.handoff({ ...input(), handoffId: 'b'.repeat(64), refreshToken: 'fresh' });
});
test('completed replay expires by timer but live X remains usable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(t);
  const result = await f.sessions.handoff(input()); f.advance(150001); t.mock.timers.tick(150001);
  await assert.rejects(f.sessions.handoff(input()), status(401)); await f.sessions.resolve(result.sessionKey);
});
test('mobile accepts payload beyond browser 4KB limit without relaxing browser parser', async t => {
  const f = fixture(t);
  await request(f.app).post('/api/mobile/auth/session').send({ ...input(), accessToken: 'a'.repeat(5000) }).expect(200);
  await request(f.app).post('/auth/refresh').send({ csrf: 'a'.repeat(5000) }).expect(413);
  const missing = await request(f.app).post('/api/mobile/missing').set('Content-Type', 'application/json').send('{').expect(404);
  assert.equal(missing.headers['set-cookie'], undefined);
});
