import type { Profile } from "../auth/profile.js";
import type { SessionStatus } from "../auth/oauth-sessions.js";

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g,
  char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export function page(profile?: Profile, csrf?: string, message?: string, status?: SessionStatus): string {
  const fields = (data: object) => Object.entries(data).map(([key, value]) =>
    '<dt>' + escapeHtml(key) + '</dt><dd>' + escapeHtml(value === null ? "—" : String(value)) + '</dd>').join("");
  const form = (action: string, label: string) =>
    '<form method="post" action="' + action + '"><input type="hidden" name="csrf" value="' +
    escapeHtml(csrf ?? "") + '"><button type="submit">' + label + '</button></form>';
  return '<!doctype html><html lang="vi"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Rita OAuth Example</title></head>' +
    '<body><main><h1>Rita OAuth Example</h1>' +
    (message ? '<p role="alert">' + escapeHtml(message) + '</p>' : '') +
    (profile ? '<h2>Đăng nhập thành công</h2><dl>' + fields(profile) + '</dl><p><a href="/api/me">JSON profile</a></p>' :
      '<p>Ứng dụng web confidential client, xác thực qua Rita ID.</p><a href="/auth/login">Login with Rita Võ</a>') +
    (status ? '<h2>Trạng thái phiên</h2><dl>' + fields({
      accessExpiresAt: new Date(status.accessExpiresAt).toISOString(),
      sessionExpiresAt: new Date(status.sessionExpiresAt).toISOString(),
      canRefresh: status.canRefresh, scopes: status.scopes.join(" "),
      refreshCount: status.refreshCount,
      lastRefreshAt: status.lastRefreshAt === null ? null : new Date(status.lastRefreshAt).toISOString(),
      verificationPending: status.verificationPending,
    }) + '</dl><a href="/api/session">JSON trạng thái</a>' +
    (status.canRefresh ? form("/auth/refresh", "Refresh ngay") : '<p>Không có refresh token; đăng nhập lại khi access token hết hạn.</p>') : '') +
    (csrf ? form("/auth/logout", "Đăng xuất app mẫu") : '') +
    '<p><a href="/">Tải lại / thử lại</a></p>' +
    '<hr><p>Demo một tiến trình. Refresh tự động khi có request, không chạy nền. Logout thu hồi phiên OAuth của app; không đăng xuất SSO Rita ID.</p>' +
    '</main></body></html>';
}
