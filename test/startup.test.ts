import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { projectRoot } from '../src/environment.js';

for (const mode of ['web', 'mobile']) test(`isolated ${mode} startup from unrelated cwd logs only mode/address`, { timeout: 20_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'rita-startup-'));
  // Copy implementation only, never any local environment file.
  const artifact = process.env.TEST_STARTUP_ARTIFACT === 'dist' ? 'dist' : 'src';
  cpSync(join(projectRoot, artifact), join(root, artifact), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  symlinkSync(join(projectRoot, 'node_modules'), join(root, 'node_modules'), 'junction');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const portReservation = createServer().listen(0, '127.0.0.1');
  await once(portReservation, 'listening');
  const port = (portReservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => portReservation.close(error => error ? reject(error) : resolve()));
  writeFileSync(join(root, `.${mode}.env`), `EXAMPLE_MODE=${mode}\nPORT=${port}\n` +
    (mode === 'web' ? 'RITA_CLIENT_ID=fictional-web\nRITA_CLIENT_SECRET=DO_NOT_LOG_THIS_SECRET\n' : 'RITA_MOBILE_CLIENT_ID=fictional-mobile\n'));
  writeFileSync(join(root, '.env'), 'NODE_ENV=production\nEXAMPLE_MODE=invalid\n');
  const args = artifact === 'dist' ? [join(root, 'dist/server.js')] :
    [join(projectRoot, 'node_modules/tsx/dist/cli.mjs'), join(root, 'src/server.ts')];
  const child = spawn(process.execPath, [...args, `--profile=${mode}`], {
    cwd: tmpdir(), env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk.toString(); });
  const closed = once(child, 'close');
  t.after(async () => { child.kill(); await closed; });
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', () => reject(new Error('Startup exited before listening: ' + errors)));
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('listening at')) resolve();
    });
  });
  assert.equal(output.trim(), `OAuth example (${mode}) listening at 127.0.0.1:${port}`);
  assert.equal(errors, '');
  assert.doesNotMatch(output, /DO_NOT_LOG|clientSecret|fictional-/);
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const origin = `http://127.0.0.1:${port}`;
  const bootstrap = await fetch(origin + '/api/session');
  assert.equal(bootstrap.status, mode === 'web' ? 200 : 404);
  assert.equal(bootstrap.headers.get('cache-control'), 'no-store');
  if (mode === 'web') {
    assert.ok(bootstrap.headers.get('set-cookie')?.includes('rita_example.key='));
    assert.deepEqual(Object.keys(await bootstrap.json()).sort(), ['authenticated', 'csrf', 'session']);
    const shell = await fetch(origin + '/');
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get('content-type') ?? '', /text\/html/);
  } else {
    assert.equal(bootstrap.headers.get('set-cookie'), null);
    assert.deepEqual(await bootstrap.json(), { error: 'not_found' });
    for (const path of ['/', '/assets/app.js', '/auth/login']) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.deepEqual(await response.json(), { error: 'not_found' });
    }
  }
  const mobile = await fetch(origin + '/api/mobile/me');
  assert.equal(mobile.status, mode === 'mobile' ? 401 : 404);
  assert.equal(mobile.headers.get('set-cookie'), null);
  assert.equal(mobile.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await mobile.json(), { error: mode === 'mobile' ? 'not_authenticated' : 'not_found' });
});
