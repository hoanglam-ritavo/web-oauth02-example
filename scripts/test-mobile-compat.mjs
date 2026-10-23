// Explicit workspace compatibility check. No import from Mobile A enters B's build/runtime.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mobileProvider } from '../test/mobile-provider.ts';
const root = resolve(process.env.MOBILE_EXAMPLE_PATH ?? '../oauth02-mobile-integration-example');
const { createBackendApi } = await import(pathToFileURL(resolve(root, 'src/services/backend-service.ts')).href);
const f = await mobileProvider();
try {
  const adapter = createBackendApi({ backendOrigin: f.origin });
  const input = await f.handoff();
  const session = await adapter.handoff(input);
  assert.equal(session.profile._id, f.subject);
  assert.deepEqual(await adapter.handoff(input), session);
  assert.equal((await adapter.me(session.sessionKey)).profile._id, f.subject);
  f.advance(301_000);
  assert.equal((await adapter.privateRequest(session.sessionKey, '/api/mobile/private/example')).subject, f.subject);
  assert.equal(f.refreshes(), 2);
  assert.equal(await adapter.logout(session.sessionKey), true);
  await assert.rejects(adapter.me(session.sessionKey), error => error.status === 401);
  console.log('Mobile A adapter -> real B HTTP -> fictional RSA/JWKS provider: passed.');
} finally { await f.close(); }
