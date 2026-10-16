import type { Profile } from "../auth/profile.js";

export const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );

function renderLogin(): string {
  return '<p>Ứng dụng tích hợp OAuth độc lập, xác thực qua Rita ID.</p><a href="/auth/login">Login with Rita Võ</a>';
}

function renderError(error: string): string {
  return `<p role="alert">${escapeHtml(error)}</p><a href="/auth/login">Đăng nhập lại</a>`;
}

function renderProfile(profile: Profile, csrf?: string): string {
  const fields = Object.entries(profile)
    .map(([key, value]) =>
      `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value === null ? "—" : String(value))}</dd>`,
    )
    .join("");
  return `<h2>Đăng nhập thành công</h2><dl>${fields}</dl>` +
    '<p><a href="/api/me">Xem JSON profile</a></p>' +
    `<form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${escapeHtml(csrf ?? "")}">` +
    '<button type="submit">Đăng xuất app mẫu</button></form>';
}

export function page(profile?: Profile, csrf?: string, error?: string): string {
  let body: string;
  if (error) body = renderError(error);
  else if (profile) body = renderProfile(profile, csrf);
  else body = renderLogin();

  return '<!doctype html><html lang="vi"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Rita OAuth Example</title></head>' +
    `<body><main><h1>Rita OAuth Example</h1>${body}` +
    '<hr><p>Demo development. Đăng xuất tại đây không đăng xuất phiên SSO Rita ID.</p></main></body></html>';
}
