import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'dotenv';
import request from 'supertest';
import { loadEnvironment, projectRoot } from '../src/environment.js';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

test('profile loader isolates files, process precedence and legacy absence', t => {
  const root = mkdtempSync(join(tmpdir(), 'rita-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(loadEnvironment([], { PORT: '3010' }, root), { PORT: '3010' });
  assert.throws(() => loadEnvironment(['--profile=mobile'], {}, root), /Unable to read/);
  writeFileSync(join(root, '.env'), 'EXAMPLE_MODE=both\nLEGACY_ONLY=yes\n');
  writeFileSync(join(root, '.web.env'), 'EXAMPLE_MODE=web\nWEB_ONLY=yes\nPORT=3003\n');
  writeFileSync(join(root, '.mobile.env'), 'EXAMPLE_MODE=mobile\nMOBILE_ONLY=yes\nPORT=3004\n');
  assert.deepEqual(loadEnvironment(['--profile=web'], { PORT: '3011' }, root),
    { EXAMPLE_MODE: 'web', WEB_ONLY: 'yes', PORT: '3011' });
  assert.deepEqual(loadEnvironment(['--profile=mobile'], {}, root),
    { EXAMPLE_MODE: 'mobile', MOBILE_ONLY: 'yes', PORT: '3004' });
  assert.equal(loadEnvironment([], {}, root).LEGACY_ONLY, 'yes');
  assert.throws(() => loadEnvironment(['--profile=web'], { EXAMPLE_MODE: 'both' }, root), /must match/);
  for (const args of [['--profile=both'], ['--profile'], ['--profile=web', '--profile=web'], ['--other=web'], ['--profile=']])
    assert.throws(() => loadEnvironment(args, {}, root), /Expected at most/);
  writeFileSync(join(root, '.web.env'), 'PORT=3003');
  assert.throws(() => loadEnvironment(['--profile=web'], {}, root), /must match/);
  assert.equal(loadEnvironment(['--profile=web'], { EXAMPLE_MODE: 'web' }, root).EXAMPLE_MODE, 'web');
});

test('mode selection validates only active configuration and preserves legacy', () => {
  const web = { RITA_CLIENT_ID: 'fictional-web', RITA_CLIENT_SECRET: 'fictional-secret' };
  const mobile = { RITA_MOBILE_CLIENT_ID: 'fictional-mobile' };
  assert.equal(readConfig(web).mode, 'web');
  assert.equal(readConfig({ ...web, ...mobile, MOBILE_AUTH_ENABLED: 'true' }).mode, 'both');
  assert.equal(readConfig({ ...web, EXAMPLE_MODE: 'web', MOBILE_AUTH_ENABLED: 'invalid', MOBILE_MAX_SESSION_ENTRIES: 'invalid' }).mode, 'web');
  const mobileConfig = readConfig({ ...mobile, EXAMPLE_MODE: 'mobile', APP_BASE_URL: 'invalid', SESSION_MAX_AGE_HOURS: '-1', MOBILE_AUTH_ENABLED: 'invalid' });
  assert.equal(mobileConfig.mode, 'mobile');
  for (const field of ['clientId', 'clientSecret', 'appUrl', 'portalUrl', 'callbackUrl', 'secureCookie']) assert.equal(field in mobileConfig, false);
  assert.equal(readConfig({ ...web, ...mobile, EXAMPLE_MODE: 'both', MOBILE_AUTH_ENABLED: 'false' }).mode, 'both');
  for (const env of [{ ...web, MOBILE_AUTH_ENABLED: 'bad' }, { ...web, EXAMPLE_MODE: 'other' },
    { ...mobile, EXAMPLE_MODE: 'both' }, { ...web, EXAMPLE_MODE: 'both' },
    { ...web, RITA_MOBILE_CLIENT_ID: web.RITA_CLIENT_ID, EXAMPLE_MODE: 'both' }]) assert.throws(() => readConfig(env));
});

test('templates parse independently; git ignores local variants but tracks templates', () => {
  for (const mode of ['web', 'mobile']) {
    const template = `.${mode}.env.example`;
    const env = parse(readFileSync(join(projectRoot, template)));
    for (const key of Object.keys(env)) if (env[key]!.startsWith('replace-')) env[key] = `fictional-${key}`;
    assert.equal(readConfig(env).mode, mode);
    assert.equal(env.PORT, mode === 'web' ? '3003' : '3004');
    assert.equal(env.MOBILE_AUTH_ENABLED, undefined);
    const paths = [`.${mode}.env`, `.${mode}.env.local`, `.${mode}.env.development.local`, template];
    const ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: projectRoot, input: paths.join('\n') + '\n', encoding: 'utf8' }).trim().split(/\r?\n/);
    assert.deepEqual(ignored, paths.slice(0, -1));
  }
});

test('mobile-only disables browser routes, cookies, SPA and proxy trust', async () => {
  const app = createApp(readConfig({ EXAMPLE_MODE: 'mobile', RITA_MOBILE_CLIENT_ID: 'fictional-mobile' }));
  assert.equal(app.get('trust proxy'), false);
  for (const path of ['/', '/dashboard', '/assets/app.js', '/api/session', '/api/me', '/auth/login', '/auth/callback']) {
    const result = await request(app).get(path).set('Accept', 'text/html').set('Cookie', 'rita_example.key=old').expect(404);
    assert.deepEqual(result.body, { error: 'not_found' });
    assert.equal(result.headers['set-cookie'], undefined);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.ok(result.headers['x-content-type-options']);
  }
  await request(app).post('/auth/logout').send({}).expect(404);
  await request(app).get('/health').expect(200, { status: 'ok' });
  await request(app).get('/api/mobile/me').expect(401);
});

test('web-only disables mobile without cookies and keeps health', async () => {
  const app = createApp(readConfig({ EXAMPLE_MODE: 'web', RITA_CLIENT_ID: 'fictional-web', RITA_CLIENT_SECRET: 'fictional-secret' }));
  for (const path of ['/api/mobile/me', '/api/mobile/unknown']) {
    const result = await request(app).get(path).expect(404);
    assert.deepEqual(result.body, { error: 'not_found' });
    assert.equal(result.headers['set-cookie'], undefined);
  }
  const result = await request(app).post('/api/mobile/auth/session').type('json').send('{').expect(404);
  assert.equal(result.headers['set-cookie'], undefined);
  await request(app).get('/health').expect(200, { status: 'ok' });
});

for (const mode of ['web', 'mobile', 'both'] as const) test(`${mode} route matrix preserves branch boundaries`, async () => {
  const app = createApp(readConfig({ EXAMPLE_MODE: mode, RITA_CLIENT_ID: 'fictional-web',
    RITA_CLIENT_SECRET: 'fictional-secret', RITA_MOBILE_CLIENT_ID: 'fictional-mobile' }));
  const cases = [
    { method: 'get', path: '/health', status: 200, body: { status: 'ok' } },
    { method: 'get', path: '/api/me', status: mode === 'mobile' ? 404 : 401 },
    { method: 'get', path: '/api/private/example', status: mode === 'mobile' ? 404 : 401 },
    { method: 'post', path: '/auth/refresh', status: mode === 'mobile' ? 404 : 401 },
    { method: 'get', path: '/api/mobile/me', status: mode === 'web' ? 404 : 401 },
    { method: 'get', path: '/api/mobile/private/example', status: mode === 'web' ? 404 : 401 },
    { method: 'post', path: '/api/mobile/auth/session', status: mode === 'web' ? 404 : 400 },
    { method: 'post', path: '/api/mobile/auth/logout', status: mode === 'web' ? 404 : 401 },
    { method: 'post', path: '/api/mobile/private/example', status: 404 },
  ] as const;
  for (const row of cases) {
    const response = await request(app)[row.method](row.path).expect(row.status);
    assert.equal(response.headers['cache-control'], 'no-store', row.path);
    assert.equal(response.headers['set-cookie'], undefined, row.path);
    assert.match(response.headers['content-type'] ?? '', /application\/json/);
    assert.deepEqual(response.body, 'body' in row ? row.body : { error:
      row.status === 404 ? 'not_found' : row.status === 400 ? 'invalid_body' : 'not_authenticated' });
  }
});
