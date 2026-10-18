/* global axios */
(() => {
  const api = axios.create({ baseURL: '/', timeout: 35000, headers: { Accept: 'application/json' } });
  const el = id => document.getElementById(id);
  const main = document.querySelector('main');
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('rita-example-auth') : null;
  let epoch = 0, csrf, authenticated = false, booting = false, mutating = false, resync = false;
  const show = (id, value) => { el(id).textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
  const clear = () => { for (const id of ['profile', 'session', 'result']) show(id, ''); };
  const state = value => {
    main.dataset.state = value;
    main.setAttribute('aria-busy', String(['bootstrapping', 'loading-profile', 'logging-out'].includes(value)));
    el('authenticated').hidden = !authenticated;
    el('login').hidden = authenticated || booting || mutating;
    el('logout').hidden = !csrf;
  };
  const session = value => {
    show('session', value);
    el('refresh').hidden = !value?.canRefresh;
    el('no-refresh').hidden = Boolean(value?.canRefresh);
  };
  const broadcast = () => channel?.postMessage('changed');
  const messages = {
    forbidden: 'Access to this resource is forbidden.',
    invalid_csrf: 'The session changed. Reload status before retrying.',
    invalid_origin: 'Invalid request origin.',
    integration_error: 'Rita ID integration configuration error. Check client credentials and permissions.',
    temporarily_unavailable: 'Rita ID is temporarily unavailable. Please retry later.',
    store_full: 'The demo session store is full. Please retry later.',
    refresh_unavailable: 'This session has no refresh token.',
    invalid_state: 'Sign-in expired, was replaced, or is invalid.',
    access_denied: 'Sign-in was declined or canceled.',
    missing_code: 'No authorization code was received.',
    authentication_failed: 'Unable to complete Rita ID sign-in. Please try again.',
  };
  function failure(error, stamp) {
    if (stamp !== epoch) return;
    const code = error.response?.data?.error;
    if (error.response?.status === 401 && code === 'not_authenticated') {
      epoch++; booting = false; authenticated = false; csrf = undefined;
      clear(); state('anonymous'); show('notice', 'Your session ended. Please sign in again.');
      broadcast(); return;
    }
    state(code === 'integration_error' ? 'integration-error' : 'temporary-error');
    const retry = error.response?.headers?.['retry-after'];
    show('notice', (messages[code] ?? 'Request failed. Check your connection and retry.') +
      (retry ? ` Retry after at least ${retry} seconds.` : ''));
  }
  async function bootstrap() {
    if (mutating || booting) { resync = true; return; }
    const stamp = ++epoch;
    booting = true; authenticated = false; csrf = undefined;
    clear(); state('bootstrapping');
    try {
      const response = await api.get('/api/session');
      if (stamp !== epoch) return;
      csrf = response.data.csrf;
      if (response.data.authenticated) {
        state('loading-profile');
        const me = await api.get('/api/me');
        if (stamp !== epoch) return;
        const status = await api.get('/api/session');
        if (stamp !== epoch) return;
        if (!status.data.authenticated || status.data.csrf !== csrf) {
          resync = true; return;
        }
        authenticated = true;
        show('profile', me.data); session(status.data.session);
      }
      state(authenticated ? 'authenticated' : 'anonymous');
      show('notice', authenticated ? 'Signed in.' : 'Not signed in.');
    } catch (error) { failure(error, stamp); }
    finally {
      booting = false;
      if (stamp === epoch) state(main.dataset.state);
      if (resync && !mutating) { resync = false; void bootstrap(); }
    }
  }
  async function run(id, work, mutation = false) {
    const control = el(id);
    if (control.disabled || mutating || booting) return;
    const stamp = mutation ? ++epoch : epoch;
    if (mutation) mutating = true;
    control.disabled = true;
    try { await work(() => stamp === epoch); }
    catch (error) { failure(error, stamp); }
    finally {
      control.disabled = false;
      if (mutation) mutating = false;
      state(main.dataset.state);
      if (resync && !mutating) { resync = false; void bootstrap(); }
    }
  }
  el('retry').addEventListener('click', () => void bootstrap());
  el('load-profile').addEventListener('click', () => void run('load-profile', async current => {
    const result = await api.get('/api/me');
    if (current()) { show('profile', result.data); show('notice', 'Profile loaded.'); }
  }));
  el('load-private').addEventListener('click', () => void run('load-private', async current => {
    const result = await api.get('/api/private/example');
    if (current()) { show('result', result.data); show('notice', 'Private API completed.'); }
  }));
  el('refresh').addEventListener('click', () => void run('refresh', async current => {
    const result = await api.post('/auth/refresh', { csrf });
    if (current()) { show('profile', result.data.profile); session(result.data.session); show('notice', 'Refreshed.'); }
  }, true));
  el('logout').addEventListener('click', () => void run('logout', async current => {
    authenticated = false; clear(); state('logging-out');
    const result = await api.post('/auth/logout', { csrf });
    if (current()) {
      csrf = undefined; state('anonymous');
      show('notice', result.data.revokeConfirmed ? 'Signed out of example.' : 'Local session removed; Rita ID revocation could not be confirmed.');
      broadcast();
    }
  }, true));
  channel?.addEventListener('message', event => {
    if (event.data !== 'changed') return;
    epoch++; authenticated = false; clear(); state('bootstrapping');
    void bootstrap();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void bootstrap(); });
  window.addEventListener('pageshow', event => { if (event.persisted) void bootstrap(); });
  window.addEventListener('online', () => void bootstrap());
  const url = new URL(window.location.href);
  const result = url.searchParams.get('auth');
  if (result !== null) {
    url.searchParams.delete('auth');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    if (result === 'success') broadcast();
  }
  void bootstrap().then(() => { if (messages[result]) show('notice', messages[result]); });
})();
