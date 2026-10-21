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
let holdUserinfo, userinfoEntered = false;
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
  const token = await new SignJWT({ token_use: "oauth_access", sub: subject }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
    .setAudience(config.clientId).setExpirationTime(now / 1000 + 300).sign(keys.privateKey);
  currentRefresh = `browser-refresh-${++issued}`;
  secrets.push(token, currentRefresh);
  res.json({ access_token: token, refresh_token: currentRefresh, token_type: 'Bearer', scope: 'openid profile email' });
});
host.get('/provider/auth/oauth/userinfo', async (_req, res) => {
  if (holdUserinfo) { const held = holdUserinfo; holdUserinfo = undefined; userinfoEntered = true; await held; }
  userinfos++;
  if (userinfoStatus !== 200) { res.sendStatus(userinfoStatus); return; }
  res.json({ _id: subject, name: '<img src=x onerror="window.injected=true">', email: 'fixture@example.com',
    employee_id: null, phone_number: null, groups: 'EMPLOYEE', is_developer: false,
    avatar: null, position: { text: null, parser: {
      group: '', company: '', department: '', board: '', region: '', store: '',
      warehouse: '', factory: '', workshop: '', showroom: '', center: '', cafe: '', others: [],
    } } });
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
    if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result); }
  });
  const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const evaluate = async (expression, sessionId) => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression, sessionId) => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression, sessionId)) return; await delay(50); }
    throw new Error(`Browser condition failed: ${expression}`);
  };
  await command('Runtime.enable');
  await command('Page.navigate', { url: origin + '/example/deep-link' });
  await waitFor('document.querySelector("main")?.dataset.state === "anonymous"');
  await evaluate('document.getElementById("login").click()');
  await waitFor('document.querySelector("main")?.dataset.state === "authenticated"');
  assert.equal(await evaluate('Boolean(window.injected)'), false);
  assert.equal(await evaluate('document.querySelector("#profile img") !== null'), false);
  assert.equal(await evaluate('document.cookie.includes("rita_example.key")'), false);
  assert.equal(await evaluate('location.search'), '');
  const beforeCookie = (await command('Network.getCookies', { urls: [origin] })).cookies.find(c => c.name === 'rita_example.key');
  assert.equal(beforeCookie.httpOnly, true);
  assert.equal(beforeCookie.sameSite, 'Lax');
  assert.equal(beforeCookie.value.length, 43);
  const initialUserinfos = userinfos;
  await evaluate('document.getElementById("load-profile").click()');
  await waitFor('!document.getElementById("load-profile").disabled');
  assert.equal(userinfos, initialUserinfos + 1);
  now += 300000;
  await evaluate('document.getElementById("load-private").click()');
  await waitFor('document.getElementById("result").textContent.includes("subject") && !document.getElementById("load-private").disabled');
  assert.equal(refreshes, 1);
  const afterCookie = (await command('Network.getCookies', { urls: [origin] })).cookies.find(c => c.name === 'rita_example.key');
  assert.equal(afterCookie.value, beforeCookie.value);
  await evaluate('document.getElementById("refresh").click(); document.getElementById("refresh").click()');
  await waitFor('!document.getElementById("refresh").disabled');
  assert.equal(refreshes, 2);
  assert.equal(await evaluate('(async()=>{ const r=await fetch("/auth/refresh",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:"{}"});return r.status; })()'), 403);
  userinfoStatus = 503;
  await evaluate('document.getElementById("load-profile").click()');
  await waitFor('document.querySelector("main").dataset.state === "temporary-error"');
  assert.equal(await evaluate('document.getElementById("logout").hidden'), false);
  userinfoStatus = 200; now += 5000;
  await evaluate('document.getElementById("load-profile").click()');
  await waitFor('document.getElementById("notice").textContent === "Profile loaded."');
  userinfoStatus = 403;
  const beforeForbidden = refreshes;
  await evaluate('document.getElementById("load-private").click()');
  await waitFor('document.getElementById("notice").textContent.includes("forbidden")');
  assert.equal(refreshes, beforeForbidden);
  assert.equal(await evaluate('document.getElementById("authenticated").hidden'), false);
  userinfoStatus = 200;
  await command('Network.enable');
  await command('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await evaluate('document.getElementById("load-profile").click()');
  await waitFor('document.getElementById("notice").textContent.includes("connection")');
  assert.equal(await evaluate('document.getElementById("authenticated").hidden'), false);
  await command('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await evaluate('document.getElementById("retry").click()');
  await waitFor('document.querySelector("main")?.dataset.state === "authenticated"');
  const html = await evaluate('document.documentElement.outerHTML');
  for (const token of secrets) assert.ok(!html.includes(token));
  assert.equal(await evaluate('localStorage.length + sessionStorage.length'), 0);
  await command('Page.reload');
  await waitFor('document.querySelector("main")?.dataset.state === "authenticated"');
  let releaseProfile;
  holdUserinfo = new Promise(resolve => { releaseProfile = resolve; });
  await evaluate('document.getElementById("load-profile").click()');
  for (let tries = 0; tries < 100 && !userinfoEntered; tries++) await delay(10);
  assert.equal(userinfoEntered, true);
  await evaluate('document.getElementById("logout").click()');
  await waitFor('document.querySelector("main").dataset.state === "anonymous" && !document.getElementById("logout").disabled');
  releaseProfile();
  await waitFor('!document.getElementById("load-profile").disabled');
  assert.equal(await evaluate('document.getElementById("profile").textContent'), '');
  assert.equal((await command('Network.getCookies', { urls: [origin] })).cookies.some(c => c.name === 'rita_example.key'), false);
  await evaluate('document.getElementById("login").click()');
  await waitFor('document.querySelector("main")?.dataset.state === "authenticated"');
  // A second real browser tab shares only the cookie and receives credential-free change signals.
  const target = await command('Target.createTarget', { url: origin });
  const attached = await command('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const second = attached.sessionId;
  await command('Runtime.enable', {}, second);
  await waitFor('document.querySelector("main")?.dataset.state === "authenticated"', second);
  await evaluate('document.getElementById("logout").click()', second);
  await waitFor('document.querySelector("main")?.dataset.state === "anonymous"', second);
  await waitFor('document.querySelector("main")?.dataset.state === "anonymous"');
  assert.equal(await evaluate('document.getElementById("profile").textContent'), '');
  await command('Target.closeTarget', { targetId: target.targetId });
  await evaluate('document.getElementById("login").click()');
  await waitFor('document.querySelector("main")?.dataset.state === "authenticated"');
  userinfoStatus = 401;
  await evaluate('document.getElementById("load-private").click()');
  await waitFor('document.querySelector("main")?.dataset.state === "anonymous"');
  assert.equal(await evaluate('document.getElementById("profile").textContent'), '');
  assert.deepEqual(browserErrors, []);
  console.log('Browser smoke passed: static SPA/deep link/reload, login, profile/private API, automatic/manual refresh, cookie/CSRF, JWKS-compatible tokens, 503 recovery, escaping, no browser token storage, cross-tab logout and 401 UI.');

} finally {
  socket?.close(); chrome.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  console.log('Temporary Chrome profile:', directory);
}
