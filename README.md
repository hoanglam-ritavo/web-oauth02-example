# Rita OAuth Example

**Express + TypeScript + EJS + Axios** minh họa OAuth 2.0 với Rita Võ ID cho hệ thống có backend
riêng (confidential client). Token ở backend, browser giữ cookie session ID, guard xác thực
và lấy profile trước handler private. Không có database user riêng.

> **Lưu trữ production:** In-memory store hiện tại chỉ dành cho demo. Khi triển khai thực tế,
> cần lưu cặp token và dữ liệu phiên liên quan trong kho độc lập với process ứng dụng, như Redis
> được cấu hình persistence phù hợp hoặc PostgreSQL với lưu trữ bền vững, để phiên không mất
> chỉ vì ứng dụng restart, redeploy hoặc downtime. Chỉ lưu token là chưa đủ; xem
> [yêu cầu lưu trữ bền vững](ARCHITECTURE.md#luu-tru-ben-vung).

## Tài liệu

| Tài liệu | Nội dung |
| --- | --- |
| [Kiến trúc](ARCHITECTURE.md) | Thành phần, ba lớp dữ liệu phiên, middleware và giới hạn vận hành |
| [1. Login và guard](docs/flows/01-login-and-guard.md) | Callback, lưu token, cookie và cách gắn guard |
| [2. Request private API](docs/flows/02-private-resource-request.md) | Axios → session → userinfo → handler |
| [3. Refresh và kết thúc phiên](docs/flows/03-refresh-and-session-termination.md) | Rotation, refetch profile, concurrency, lỗi và logout |

## Luồng tổng quan

1. Browser đăng nhập Rita ID bằng Authorization Code + PKCE S256.
2. Backend đổi code, xác minh JWT/profile, tạo session ID mới và lưu token trong RAM.
3. Browser nhận cookie HttpOnly `rita_example.sid`; EJS render trang, Axios gọi API cùng origin.
4. Guard tra phiên, xác minh access token và gọi userinfo, gắn `req.auth` trước khi chạy handler.
5. Token hết hạn được refresh ở backend; cập nhật cùng phiên, lấy lại profile, tiếp tục request.
6. Logout xóa phiên/cookie ứng dụng và thử revoke tại Rita ID; không logout SSO Rita ID.

Axios frontend **không refresh trong interceptor, không tự replay request**. Khi nhận
`401 not_authenticated`, nó xóa UI và chuyển về `/`. Lỗi 403/502/503 hoặc lỗi mạng được hiển thị,
không tự logout. Không trả OAuth token/client secret xuống browser.

## Chạy local

Yêu cầu Node.js 24, npm, Rita ID backend và developer portal hoạt động. Tạo confidential client
trên portal, đăng ký callback chính xác **http://localhost:3003/auth/callback**, không slash cuối.
Chỉ chạy một process; `NODE_ENV=production` bị chặn vì dùng RAM.

```powershell
npm ci
# Chỉ copy nếu chưa có .env, không ghi đè cấu hình hiện tại.
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm run dev
```

Điền client ID, client secret, SESSION_SECRET ngẫu nhiên vào `.env`; không commit secret.
Mở **http://localhost:3003**. Không trộn localhost và 127.0.0.1 trong cùng phiên.

| Biến | Mặc định / yêu cầu |
| --- | --- |
| NODE_ENV | development/test; production bị chặn |
| PORT | 3003 |
| APP_BASE_URL | http://localhost:3003 |
| RITA_PORTAL_URL | http://localhost:3000 |
| RITA_API_URL | http://localhost:3000/api; cho phép path prefix |
| RITA_CLIENT_ID | Bắt buộc, confidential client |
| RITA_CLIENT_SECRET | Bắt buộc, chỉ phía server |
| SESSION_SECRET | Bắt buộc, tối thiểu 32 ký tự |
| SESSION_MAX_AGE_HOURS | 8; lớn hơn 0, tối đa 24 |

`RITA_API_URL=http://localhost:3000/api` đi qua rewrite portal; `http://localhost:4000` gọi trực
tiếp backend. APP_BASE_URL và RITA_PORTAL_URL chỉ nhận origin. Đổi port phải đồng bộ callback.
Ứng dụng listen 127.0.0.1; HTTPS local cần reverse proxy loopback và X-Forwarded-Proto.
Cookie HttpOnly, SameSite=Lax, Path=/, không Domain; Secure khi APP_BASE_URL là HTTPS.
Token/userinfo/revoke là server-to-server, không cần thêm origin ứng dụng vào CORS Rita ID
cho các request này. OAuth refresh dùng `/auth/oauth/token`, khác `/auth/refresh` của SSO Rita ID.

## API

| Method | Path | Hành vi |
| --- | --- | --- |
| GET | / | EJS shell và metadata; browser tải profile bằng Axios |
| GET | /auth/login | Redirect portal với state/PKCE |
| GET | /auth/callback | Đổi code, tạo phiên, redirect / |
| GET | /api/me | Guard + profile mới từ Rita ID |
| GET | /api/private/example | Guard + `{ message, subject }` |
| GET | /api/session | Metadata phiên; không refresh hoặc gọi userinfo |
| POST | /auth/refresh | CSRF; refresh thủ công |
| POST | /auth/logout | CSRF; revoke, xóa phiên và cookie |
| GET | /health | `{ status: "ok" }`, không gọi Rita ID |

Axios gửi `Accept: application/json` và body `{ csrf }` khi refresh/logout.
Refresh trả `{ profile, session }`; logout trả `{ loggedOut: true, revokeConfirmed }`.
Form truyền thống nhận URL-encoded body và redirect 303. API lỗi trả `{ error }`.
Callback JSON tùy chọn trả `{ profile, expiresAt }`, vẫn yêu cầu login attempt hợp lệ.
Chi tiết lỗi: [refresh/logout](docs/flows/03-refresh-and-session-termination.md).

## Kiểm chứng

```powershell
npm run typecheck
npm test
npm run build
npm start
# Provider giả lập và Chrome headless, không đọc .env:
npm run test:browser
```

Build copy EJS, CSS, JavaScript và Axios browser bundle vào `dist`; đường dẫn dựa trên module.
Browser smoke dùng Chrome tại đường dẫn Windows mặc định, có thể đặt `CHROME_PATH`; script in
đường dẫn profile Chrome tạm để dọn sau kiểm thử. Asset phục vụ cùng origin, không CDN.

**Kết quả đã ghi nhận ngày 2026-10-17:** typecheck, 69/69 tests, build và Chrome smoke pass.
Đây là kết quả của lần triển khai trước, không phải lần chạy mới khi cập nhật tài liệu.
Tests dùng fixtures/HTTP provider giả lập và RSA/JWKS; chưa kiểm thử live backend/HRM hoặc TLS proxy.
Kết quả giả lập không chứng minh concurrency PostgreSQL phía Rita ID.

Kiểm thử live riêng với tài khoản/client test: login/consent, refresh, logout và lỗi HRM có kiểm soát.
Không replay refresh token thật trên hệ thống dùng chung. Hạn chế revoke/userinfo và kho RAM
được giải thích trong [kiến trúc](ARCHITECTURE.md).
