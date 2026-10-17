// Runs the built app against a local, fictional OAuth provider. No .env or live accounts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createApp } from '../dist/app.js';
import { readConfig } from '../dist/config.js';

const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const directory = await mkdtemp(join(tmpdir(), 'rita-example-browser-'));
const keys = await generateKeyPair('RS256');
const subject = '12345678-1234-4123-8123-123456789012';
const config = readConfig({ RITA_CLIENT_ID: 'browser-client', RITA_CLIENT_SECRET: 'browser-secret', SESSION_SECRET: 's'.repeat(40) });
let now = Math.floor(Date.now() / 1000) * 1000;
let refreshes = 0, issued = 0, currentRefresh = '', userinfos = 0, userinfoStatus = 200;
const secrets = [];
const host = express();
host.use(express.json());
host.get('/oauth/authorize', (req, res) => {
  const url = new URL(config.callbackUrl);
  url.search = new URLSearchParams({ code: 'fixture-code', state: req.query.state }).toString();
  res.redirect(url.toString());
});
host.get('/provider/.well-known/jwks.json', async (_req, res) => res.json({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'fixture', alg: 'RS256' }] }));
host.post('/provider/auth/oauth/token', async (req, res) => {
  assert.equal(req.body.client_secret, config.clientSecret);
  if (req.body.grant_type === 'refresh_token') {
    assert.equal(req.body.refresh_token, currentRefresh);
    refreshes++;
  }
  const token = await new SignJWT({ sub: subject }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
    .setAudience(config.clientId).setExpirationTime(now / 1000 + 300).sign(keys.privateKey);
  currentRefresh = `browser-refresh-${++issued}`;
  secrets.push(token, currentRefresh);
  res.json({ access_token: token, refresh_token: currentRefresh, token_type: 'Bearer', scope: 'openid profile email' });
});
host.get('/provider/auth/oauth/userinfo', (_req, res) => {
  userinfos++;
  if (userinfoStatus !== 200) { res.sendStatus(userinfoStatus); return; }
  res.json({ _id: subject, name: '<img src=x onerror="window.injected=true">', email: 'fixture@example.com',
    employee_id: null, phone_number: null, groups: 'EMPLOYEE', is_developer: false });
});
host.post('/provider/auth/oauth/revoke', (_req, res) => res.sendStatus(200));
const server = host.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
Object.assign(config, { appUrl: origin, portalUrl: origin, apiUrl: origin + '/provider', callbackUrl: origin + '/auth/callback' });
host.use(createApp(config, { now: () => now }));
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; }
    catch { await delay(100); }
  }
  assert.ok(port, 'Chrome must open its local DevTools endpoint');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open');
  let sequence = 0;
  const pending = new Map();
  const browserErrors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails.text);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result); }
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(50); }
    throw new Error(`Browser condition failed: ${expression}`);
  };
  await command('Runtime.enable');
  await command('Page.navigate', { url: origin });
  await waitFor('Boolean(document.querySelector(\'a[href="/auth/login"]\'))');
  await evaluate('document.querySelector(\'a[href="/auth/login"]\').click()');
  await waitFor('document.getElementById("profile")?.textContent.includes("fixture@example.com")');
  assert.equal(await evaluate('Boolean(window.injected)'), false);
  assert.equal(await evaluate('document.querySelector("#profile img") !== null'), false);
  assert.equal(await evaluate('document.cookie.includes("rita_example.sid")'), false);
  const beforeCookie = (await command('Network.getCookies', { urls: [origin] })).cookies.find(c => c.name === 'rita_example.sid');
  assert.equal(beforeCookie.httpOnly, true);
  const initialUserinfos = userinfos;
  await evaluate('document.getElementById("load-profile").click()');
  await waitFor('!document.getElementById("load-profile").disabled');
  assert.equal(userinfos, initialUserinfos + 1);
  now += 300000;
  await evaluate('document.getElementById("load-private").click()');
  await waitFor('document.getElementById("result").textContent.includes("subject") && !document.getElementById("load-private").disabled');
  assert.equal(refreshes, 1);
  const afterCookie = (await command('Network.getCookies', { urls: [origin] })).cookies.find(c => c.name === 'rita_example.sid');
  assert.equal(afterCookie.value, beforeCookie.value);
  await evaluate('document.querySelector("#refresh-form button").click()');
  await waitFor('!document.querySelector("#refresh-form button").disabled');
  assert.equal(refreshes, 2);
  assert.equal(await evaluate('(async()=>{ const r=await fetch("/auth/refresh",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:"{}"});return r.status; })()'), 403);
  userinfoStatus = 503;
  await evaluate('document.getElementById("load-profile").click()');
  await waitFor('document.getElementById("notice").textContent.includes("tạm thời")');
  assert.equal(await evaluate('Boolean(document.getElementById("logout-form"))'), true);
  userinfoStatus = 200; now += 5000;
  await evaluate('document.getElementById("load-profile").click()');
  await waitFor('document.getElementById("notice").textContent === "Hoàn tất."');
  const html = await evaluate('document.documentElement.outerHTML');
  for (const token of secrets) assert.ok(!html.includes(token));
  await evaluate('document.querySelector("#logout-form button").click()');
  await waitFor('Boolean(document.querySelector(\'a[href="/auth/login"]\'))');
  assert.equal((await command('Network.getCookies', { urls: [origin] })).cookies.some(c => c.name === 'rita_example.sid'), false);
  await evaluate('document.querySelector(\'a[href="/auth/login"]\').click()');
  await waitFor('document.getElementById("profile")?.textContent.includes("fixture@example.com")');
  userinfoStatus = 401;
  await evaluate('document.getElementById("load-private").click()');
  await waitFor('Boolean(document.querySelector(\'a[href="/auth/login"]\'))');
  assert.deepEqual(browserErrors, []);
  console.log('Browser smoke passed: EJS, local Axios, login, profile, private API, automatic/manual refresh, stable HttpOnly cookie, CSRF, 503 recovery, escaping, logout and 401 redirect.');
} finally {
  socket?.close(); chrome.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  console.log('Temporary Chrome profile:', directory);
}
