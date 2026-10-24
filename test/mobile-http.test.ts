import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mobileProvider } from './mobile-provider.js';
const post = (origin: string, body: unknown) => fetch(origin + '/api/mobile/auth/session', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
for (const mode of ['mobile', 'both'] as const) test(`real RSA/JWKS HTTP handoff/refresh (${mode}) uses public client; X and deadline stay fixed`, async t => {
  const f = await mobileProvider(mode); t.after(f.close);
  const input = await f.handoff(); const first = await post(f.origin, input); assert.equal(first.status, 200);
  const session = await first.json(); assert.equal(session.profile.sub, f.subject);
  assert.deepEqual(await (await post(f.origin, input)).json(), session); assert.equal(f.refreshes(), 1);
  const privateResult = await fetch(f.origin + '/api/mobile/private/example', { headers: { Authorization: `Bearer ${session.sessionKey}` } });
  assert.equal(privateResult.status, 200);
  assert.equal(privateResult.headers.get('set-cookie'), null);
  assert.equal(privateResult.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await privateResult.json(), { message: 'Private resource accessed.', subject: f.subject });
  const wrongMethod = await fetch(f.origin + '/api/mobile/private/example', {
    method: 'POST', headers: { Authorization: `Bearer ${session.sessionKey}`, 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(wrongMethod.status, 404);
  assert.deepEqual(await wrongMethod.json(), { error: 'not_found' });
  assert.equal(wrongMethod.headers.get('set-cookie'), null);
  assert.equal(wrongMethod.headers.get('cache-control'), 'no-store');
  assert.equal(f.refreshes(), 1);
  f.advance(301_000);
  const results = await Promise.all(Array.from({ length: 6 }, () => fetch(f.origin + '/api/mobile/me', { headers: { Authorization: `Bearer ${session.sessionKey}` } })));
  for (const result of results) { assert.equal(result.status, 200); const data = await result.json(); assert.equal(data.expiresAt, session.expiresAt); }
  assert.equal(f.refreshes(), 2);
  const logout = await fetch(f.origin + '/api/mobile/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${session.sessionKey}` } });
  assert.equal(logout.status, 200); assert.equal((await logout.json()).revokeConfirmed, true);
  for (const call of f.calls) { assert.equal(call.body.client_id, 'mobile'); assert.equal('client_secret' in call.body, false); }
});
for (const variant of ['audience', 'signature', 'purpose', 'expiry', 'scope', 'subject', 'refresh-subject', 'refresh-scope']) test(`real provider rejects mobile ${variant}`, async t => {
  const f = await mobileProvider(); t.after(f.close); const input = await f.handoff();
  if (variant === 'audience') input.accessToken = await f.sign({ aud: 'browser' });
  if (variant === 'signature') input.accessToken = await f.sign({}, true);
  if (variant === 'purpose') input.accessToken = await f.sign({ token_use: 'id_token' });
  if (variant === 'expiry') input.accessToken = await f.sign({ exp: 1 });
  if (variant === 'scope') input.accessToken = await f.sign({ scope: 'openid' });
  if (variant === 'subject') input.accessToken = await f.sign({ sub: 'bad-id' });
  if (variant === 'refresh-subject') f.state.refreshSubject = '22345678-1234-4123-8123-123456789012';
  if (variant === 'refresh-scope') f.state.refreshScope = 'openid profile';
  const result = await post(f.origin, input); assert.equal(result.status, 401);
  assert.equal(f.refreshes(), variant.startsWith('refresh-') ? 1 : 0);
});
test('real lost provider refresh response never resubmits the consumed token', async t => {
  const f = await mobileProvider(); t.after(f.close); f.state.loseRefreshResponse = true;
  const input = await f.handoff(); assert.equal((await post(f.origin, input)).status, 401);
  assert.equal((await post(f.origin, input)).status, 401); assert.equal(f.refreshes(), 1);
});
test('real JWKS outage is retryable before rotation', async t => {
  const f = await mobileProvider(); t.after(f.close); const input = await f.handoff(); f.state.jwksStatus = 503;
  assert.equal((await post(f.origin, input)).status, 503); assert.equal(f.refreshes(), 0);
  f.state.jwksStatus = 200; f.advance(5001);
  assert.equal((await post(f.origin, input)).status, 200); assert.equal(f.refreshes(), 1);
});
