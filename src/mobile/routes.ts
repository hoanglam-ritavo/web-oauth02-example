import express, { type ErrorRequestHandler, type Request } from 'express';
import type { Config } from '../config.js';
import { createOAuthClient } from '../auth/oauth-client.js';
import { SessionError } from '../auth/oauth-sessions.js';
import { MobileSessions, type Handoff } from './mobile-sessions.js';

function bearer(req: Request): string {
  const headers = req.rawHeaders.filter((_value, index) => index % 2 === 0 && req.rawHeaders[index]!.toLowerCase() === 'authorization');
  const value = req.headers.authorization;
  if (headers.length !== 1 || !value || !/^Bearer [A-Za-z0-9_-]{43}$/.test(value)) throw new SessionError('not_authenticated', 401);
  return value.slice(7);
}
function payload(body: unknown, clientId: string): Handoff {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SessionError('invalid_body', 400);
  const value = body as Record<string, unknown>;
  const fields = ['handoffId', 'clientId', 'accessToken', 'refreshToken'];
  if (Object.keys(value).length !== 4 || !fields.every(k => typeof value[k] === 'string' && value[k] && !/\s/.test(value[k] as string)) ||
      !/^[0-9a-f]{64}$/.test(value.handoffId as string)) throw new SessionError('invalid_body', 400);
  if (value.clientId !== clientId) throw new SessionError('forbidden', 403);
  return value as unknown as Handoff;
}
export function createMobileRouter(config: Config, now = Date.now, injected?: MobileSessions) {
  const router = express.Router();
  if (!config.mobile.enabled) {
    router.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
    return router;
  }
  const sessions = injected ?? new MobileSessions(config.mobile, createOAuthClient(config, { now, publicClientId: config.mobile.clientId }), now);
  router.use((req, res, next) => {
    const known = (req.method === 'POST' && ['/auth/session', '/auth/logout'].includes(req.path)) ||
      (req.method === 'GET' && ['/me', '/private/example'].includes(req.path));
    if (!known) { res.status(404).json({ error: 'not_found' }); return; }
    if (req.headers.origin !== undefined) { res.status(403).json({ error: 'invalid_origin' }); return; }
    next();
  });
  router.use(express.json({ limit: '16kb' }));
  router.post('/auth/session', async (req, res) => {
    if (!req.is('application/json')) throw new SessionError('invalid_body', 400);
    res.json(await sessions.handoff(payload(req.body, config.mobile.clientId)));
  });
  router.get('/me', async (req, res) => { res.json(await sessions.resolve(bearer(req))); });
  router.get('/private/example', async (req, res) => {
    const identity = await sessions.resolve(bearer(req));
    res.json({ message: 'Private resource accessed.', subject: identity.profile.sub });
  });
  router.post('/auth/logout', async (req, res) => {
    if (req.body !== undefined || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') || req.headers['transfer-encoding']) throw new SessionError('invalid_body', 400);
    res.json(await sessions.logout(bearer(req)));
  });
  router.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error instanceof SessionError ? error.status : error?.type === 'entity.parse.failed' ? 400 : error?.type === 'entity.too.large' ? 413 : 500;
    const code = error instanceof SessionError ? error.code : status === 400 ? 'invalid_body' : status === 413 ? 'body_too_large' : 'internal_error';
    if (error instanceof SessionError && error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    res.status(status).json({ error: code });
  };
  router.use(onError);
  return router;
}
