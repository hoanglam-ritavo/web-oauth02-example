/* global axios */
(() => {
  const api = axios.create({ baseURL: '/', timeout: 35000, headers: { Accept: 'application/json' } });
  let epoch = 0;
  let leaving = false;
  const element = id => document.getElementById(id);
  const show = (id, value) => { if (element(id)) element(id).textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
  const clear = () => { for (const id of ['profile', 'session', 'result']) show(id, ''); };
  const leave = (url = '/') => {
    if (leaving) return;
    leaving = true;
    epoch++;
    clear();
    window.location.assign(url);
  };
  api.interceptors.response.use(response => response, error => {
    if (error.response?.status === 401 && error.response.data?.error === 'not_authenticated') leave();
    return Promise.reject(error);
  });
  const messages = {
    forbidden: 'Bạn không có quyền truy cập tài nguyên này.',
    invalid_csrf: 'Phiên biểu mẫu không hợp lệ. Hãy tải lại trang.',
    integration_error: 'Lỗi cấu hình tích hợp Rita ID.',
    temporarily_unavailable: 'Rita ID tạm thời không khả dụng. Vui lòng thử lại sau.',
    refresh_unavailable: 'Phiên này không có refresh token.',
  };
  async function run(control, work) {
    if (leaving || control?.disabled) return;
    const snapshot = epoch;
    if (control) control.disabled = true;
    show('notice', 'Đang xử lý…');
    const current = () => snapshot === epoch && !leaving;
    try {
      await work(current);
      if (current()) show('notice', 'Hoàn tất.');
    } catch (error) {
      if (current()) {
        const retry = error.response?.headers?.['retry-after'];
        show('notice', (messages[error.response?.data?.error] ?? 'Không thể hoàn tất yêu cầu. Vui lòng thử lại.') +
          (retry ? ` Thử lại sau ít nhất ${retry} giây.` : ''));
      }
    } finally { if (control) control.disabled = false; }
  }
  async function status(current) {
    const response = await api.get('/api/session');
    if (current()) show('session', response.data);
  }
  const loadProfile = () => run(element('load-profile'), async current => {
    const response = await api.get('/api/me');
    if (current()) show('profile', response.data);
    if (current()) await status(current);
  });
  element('load-profile')?.addEventListener('click', loadProfile);
  element('load-private')?.addEventListener('click', () => run(element('load-private'), async current => {
    const response = await api.get('/api/private/example');
    if (current()) { show('result', response.data); await status(current); }
  }));
  element('refresh-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    run(form.querySelector('button'), async current => {
      const response = await api.post('/auth/refresh', { csrf: new FormData(form).get('csrf') });
      if (current()) { show('profile', response.data.profile); show('session', response.data.session); }
    });
  });
  element('logout-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    epoch++; // Ignore older profile/refresh responses even if logout fails.
    run(form.querySelector('button'), async current => {
      const response = await api.post('/auth/logout', { csrf: new FormData(form).get('csrf') });
      if (current()) leave(response.data.revokeConfirmed ? '/' : '/?notice=revoke_unconfirmed');
    });
  });
  if (document.querySelector('main').dataset.authenticated === 'true') loadProfile();
})();
