# Rita OAuth Example

App Express + TypeScript độc lập để kiểm chứng **Login with Rita Võ** bằng trình duyệt. Chỉ dùng development, không database, không tự refresh OAuth, không thay đổi Rita ID backend/portal.

## Chạy local

Yêu cầu Node.js 24, npm, Rita ID Backend và Developer Portal đang chạy. Backend cần PostgreSQL/Odoo phù hợp cho login thực tế.

1. Đăng nhập developer portal bằng tài khoản Odoo đang hoạt động. Register local hiện chưa cung cấp login bằng mật khẩu local.
2. Tạo OAuth client trên portal:
   - Name: `OAuth Example`.
   - Callback/redirect URI: **`http://localhost:3003/auth/callback`** (khớp chính xác, không thêm dấu slash cuối).
   - Allowed scopes: `openid`, `profile`, `email`.
   - Ghi lại client ID và secret được trả khi tạo. Chỉ điền secret vào môi trường server.
3. Trong thư mục project:

```powershell
npm ci
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Không ghi đè `.env` đã có. Dùng giá trị ngẫu nhiên vừa sinh cho `SESSION_SECRET`; điền `RITA_CLIENT_ID`, `RITA_CLIENT_SECRET` từ client vừa tạo. Các placeholder sẽ bị từ chối khi startup. Không commit `.env`.

```powershell
npm run dev
```

Mở **http://localhost:3003** và bấm **Login with Rita Võ**.

## Cấu hình

| Biến | Mặc định / yêu cầu |
| --- | --- |
| NODE_ENV | Development/test; production bị chặn |
| PORT | 3003 |
| APP_BASE_URL | http://localhost:3003 |
| RITA_PORTAL_URL | http://localhost:3000 |
| RITA_API_URL | http://localhost:3000/api |
| RITA_CLIENT_ID | Bắt buộc |
| RITA_CLIENT_SECRET | Bắt buộc; chỉ dùng server-to-server |
| SESSION_SECRET | Bắt buộc; ít nhất 32 ký tự, sinh ngẫu nhiên |

APP_BASE_URL và RITA_PORTAL_URL là origin HTTP(S), không path/query/fragment/credentials. RITA_API_URL là base URL HTTP(S), cho phép path và tự bỏ dấu `/` cuối; không cho phép query/fragment/credentials. Đổi PORT thì đổi APP_BASE_URL và đăng ký lại callback tương ứng.

**Portal URL** dành cho điều hướng trình duyệt đến `/oauth/authorize`. **API URL** dành cho server gọi `/auth/oauth/token`, `/auth/oauth/userinfo` và `/.well-known/jwks.json`; không thêm `/api` vào URL backend trực tiếp.

Mặc định, developer portal chạy port 3000 và rewrite `/api/:path*` sang backend `/:path*`. Với `RITA_API_URL=http://localhost:3000/api`, cả token, userinfo và JWKS được gọi qua `/api/auth/oauth/token`, `/api/auth/oauth/userinfo` và `/api/.well-known/jwks.json`. Proxy cần giữ nguyên body và header `Authorization`, không redirect các endpoint này, không cache token/userinfo hoặc ghi log credentials. Luồng OAuth sẽ phụ thuộc vào cả portal proxy và backend.

Để gọi backend trực tiếp, đặt `RITA_API_URL=http://localhost:4000`. Chỉ sửa biến này trong `.env` đã có, giữ nguyên các secret; `.env.example` là mẫu, không phải cấu hình runtime. Restart app sau khi đổi env; các phiên MemoryStore cũ sẽ mất.

Server mặc định chỉ nghe trên `127.0.0.1`. HTTP localhost là cấu hình được hướng dẫn và kiểm thử. Nếu dùng HTTPS local, cấu hình APP_BASE_URL là HTTPS và cung cấp TLS reverse proxy trên loopback chuyển tiếp `X-Forwarded-Proto`; app chỉ tin proxy loopback khi bật HTTPS. Không mở backend này trực tiếp ra mạng và không tin proxy tùy ý. Proxy không được ghi log query callback hoặc token. Project không tự cấp chứng chỉ hoặc triển khai TLS.

## Luồng

1. `GET /auth/login` sinh state và PKCE S256; lưu yêu cầu trong session tối đa 10 phút. Login mới thay yêu cầu cũ; chỉ hỗ trợ một attempt đang chờ trên mỗi session trình duyệt. Identity đang đăng nhập được giữ đến khi callback thành công hoặc hết hạn.
2. Redirect portal với client ID, callback, state, scope và challenge.
3. Portal xử lý login/consent và redirect về `GET /auth/callback`.
4. Callback kiểm tra state kể cả khi bị từ chối; claim attempt một lần trước khi đổi code. Map claim trong bộ nhớ chặn hai callback đồng thời cùng đổi code.
5. Server POST JSON đổi code; xác minh access JWT RS256 qua JWKS, audience/client ID, expiry và UUID subject.
6. Gọi userinfo; subject phải trùng JWT. Chỉ lấy các field profile được hỗ trợ.
7. Regenerate session ID, lưu profile và CSRF token; redirect về trang chủ để URL không còn code.

Không dùng ID token để xác thực. Không lưu access/refresh/ID token sau callback và không trả chúng ra trình duyệt. Chưa kiểm tra issuer vì Rita ID hiện không cấp issuer đầy đủ; JWKS origin được cố định bằng cấu hình server. Đây là adapter cho hợp đồng hiện tại, không phải chứng nhận OIDC chuẩn.

Provider hiện bỏ qua kiểm tra client secret nếu code có PKCE. App vẫn gửi secret server-to-server; điều này không sửa hạn chế provider. Provider có trả refresh token và tạo session tương ứng nhưng app mẫu không sử dụng token đó; logout app mẫu không thu hồi session phía provider.

## API và phiên

| Method | Path | Kết quả |
| --- | --- | --- |
| GET | / | HTML login hoặc profile/logout |
| GET | /auth/login | Redirect đến portal |
| GET | /auth/callback | Xử lý code/error và state |
| GET | /api/me | Profile JSON; 401 nếu chưa login/hết hạn |
| POST | /auth/logout | Bắt buộc CSRF token form; xóa session local, redirect 303 |
| GET | /health | `{"status":"ok"}`; không gọi dịch vụ ngoài |

Profile contains seven required fields: `sub`, `name`, `email`, `employee_id`, `phone_number`, `is_developer`, and `groups`. The adapter requires backend userinfo `_id` to match JWT `sub`, then maps `_id -> sub` for the local profile and `/api/me`. Employee code and phone number may be null. Groups are EMPLOYEE, CUSTOMER or ENTERPRISE; developer status is displayed, not used to restrict demo login.

Cookie `rita_example.sid`: HTTP-only, SameSite=Lax, Path=/, không Domain, Secure khi HTTPS. Cookie localhost không được cách ly theo port nên tên này khác cookie Rita ID. Không trộn hostname `localhost` và `127.0.0.1` trong cùng luồng login.

Phiên local tồn tại tối đa 5 phút, không vượt expiry JWT, được kiểm tra phía server. Hết hạn thì login lại; phiên SSO Rita ID còn hiệu lực có thể giúp bỏ qua nhập mật khẩu. MemoryStore mất dữ liệu khi restart, chỉ dùng một tiến trình. Không có refresh, logout toàn hệ thống hay quản lý client/consent.

Các response đặt no-store; Helmet đặt security headers. Không ghi log URL callback/token/secret. Lỗi upstream không được trả nguyên văn cho trình duyệt. Token/userinfo và JWKS có timeout 10 giây, không tự retry đổi code.

## Kiểm chứng

```powershell
npm run typecheck
npm test
npm run build
npm start
```

Tests dùng Node test runner + tsx, Supertest, JWT RSA thật với JWKS giả lập và HTTP giả lập. Bao phủ redirect/state/PKCE, callback lặp và đồng thời, token sai chữ ký/audience/expiry, userinfo không khớp, timeout/lỗi upstream, HTML escaping, CSRF, session rotation/hết hạn/restart và cấu hình.

Smoke test thực tế:
1. Cấu hình client như trên; chạy cả backend, portal và app mẫu.
2. Dùng cửa sổ trình duyệt mới: Login → nhập tài khoản Odoo → Allow → thấy đúng profile.
3. Mở /api/me: kiểm tra `sub`, không có token.
4. Logout app mẫu: /api/me trả 401. Login lại kiểm tra tái sử dụng SSO.
5. Thử Deny bằng client chưa được consent: không tạo phiên local.
6. Chờ hết phiên hoặc restart app: yêu cầu login lại.
7. Để kiểm tra nhiều tài khoản đúng danh tính, Rita ID cần `MOCKUP_MODE=false`. Khi true, backend lấy nhân viên cố định ID 4 sau login Odoo thật.

Lỗi thường gặp:
- Invalid redirect URI: kiểm tra scheme, hostname, port, path và slash cuối trùng đăng ký.
- State không hợp lệ: cookie bị mất, callback dùng lại, quá 10 phút hoặc đã bấm login mới.
- Login thất bại: kiểm tra backend/Odoo, client config, JWKS và đồng hồ máy; không dán token vào log.
- Cookie HTTPS không được đặt: cần TLS proxy loopback đúng cấu hình; local mặc định dùng HTTP.
- Port đã dùng: thay PORT, APP_BASE_URL và callback đăng ký đồng bộ.

Kết quả test giả lập không chứng minh kết nối PostgreSQL/Odoo hoặc toàn bộ SSO thật. Chỉ ghi nhận smoke test thực tế sau khi có tài khoản/client phù hợp; không tự sửa backend để làm demo chạy.

## Cấu trúc

### RitaAuthStrategy cho login và callback API

`RitaAuthStrategy` là strategy dành cho Express của project, không phải Passport
Strategy hay NestJS provider. Strategy thực hiện state/PKCE, đổi code, xác minh
JWT/userinfo qua OAuth client, tạo lại session và gán `req.auth`. `RitaAuthGuard`
kiểm tra session đó ở các request tiếp theo. Không đặt guard trước callback vì
người dùng chưa có phiên đăng nhập ở bước này.

`src/auth/routes.ts` đã dùng trực tiếp `strategy.login` và `strategy.callback`.
Mặc định callback vẫn redirect về `/`. Để dùng callback trả JSON trong app này:

```ts
const app = createApp(config, { callbackResponse: "json" });
```

Callback thành công trả `200 { profile, expiresAt }` và cookie session. Callback
lỗi trả JSON với `error`: `invalid_state`, `access_denied`, `missing_code` (400),
`authentication_failed` (502), hoặc `internal_error` (500). Không trả token hay
lỗi upstream. Chế độ JSON vẫn dùng browser session: phải bắt đầu tại `/auth/login`
và gửi lại cùng cookie khi callback; đây không phải API nhận code tùy ý từ client.

Để gắn vào router Express khác:

```ts
import { RitaAuthStrategy, RitaAuthError } from "./auth/rita-auth.strategy.js";
import { createSessionMiddleware } from "./auth/session.js";
import type { ErrorRequestHandler } from "express";

app.use(createSessionMiddleware(config));
const strategy = new RitaAuthStrategy({ config });
app.get("/auth/login", strategy.login);
app.get("/auth/callback", strategy.callback, (req, res) => {
  res.json(req.auth); // Hoặc res.redirect("/") cho trang web.
});
const authError: ErrorRequestHandler = (error, _req, res, _next) => {
  res.status(error instanceof RitaAuthError ? error.status : 500).json({
    error: error instanceof RitaAuthError ? error.code : "internal_error",
  });
app.use("/auth/callback", authError);
```

Dùng cùng một instance strategy cho login và callback trong mỗi app. Callback URL
trong config phải khớp route và URI đã đăng ký tại Rita ID. Session/claims vẫn nằm
trong bộ nhớ, chỉ hỗ trợ demo một tiến trình. Cấu hình `oauth`, `now`, `pendingClaims`
có thể được truyền vào constructor để kiểm thử hoặc dùng các dependency có sẵn.

### Bảo vệ route bằng RitaAuthGuard (Express)

`RitaAuthGuard` kiểm tra phiên server được tạo sau callback Rita ID. Cài middleware
session trước guard; guard tự kiểm tra thời hạn nên không phụ thuộc `expireIdentity`.
Guard không xác thực bearer token do client gửi và không thay thế các route OAuth.

```ts
import { RitaAuthGuard } from "./auth/rita-auth.guard.js";

const apiAuth = new RitaAuthGuard();
router.get("/api/private", apiAuth.handle, (req, res) => {
  res.json(req.auth!.profile);
});

const pageAuth = new RitaAuthGuard({ unauthenticated: "redirect" });
router.get("/dashboard", pageAuth.handle, dashboardHandler);
```

Mặc định, chưa đăng nhập hoặc hết hạn trả `401 { error: "not_authenticated" }`.
Chế độ `redirect` trả 303 đến `/auth/login`; callback hiện quay về `/`, không lưu
URL quay lại. `req.auth` chứa `profile` và `expiresAt`, không chứa CSRF hoặc OAuth
token. Chỉ dùng `req.auth!` trong handler đứng sau guard. `/api/me` đã dùng guard;
`/`, `/health` và các route OAuth vẫn truy cập công khai. Guard chỉ xác thực đăng
nhập, không kiểm tra quyền theo nhóm và không thay thế CSRF cho thao tác ghi.

### Các file

- `src/config.ts`: validation cấu hình.
- `src/auth/rita-auth.guard.ts`: guard Express dùng lại cho các route cần đăng nhập.
- `src/auth/rita-auth.strategy.ts`: strategy dùng chung cho login và xác thực callback.
- `src/app.ts`: ghép dependencies, middleware, routers và xử lý lỗi HTTP.
- `src/auth/routes.ts`: gắn strategy vào login/callback, chọn HTML/JSON response và xử lý logout.
- `src/auth/session.ts`: session types, cookie, middleware hết hạn và helpers lưu/tạo lại phiên.
- `src/auth/pending-claims.ts`: kho claims riêng cho mỗi app, ngăn callback dùng lại hoặc đồng thời.
- `src/auth/oauth-client.ts`: đổi code, xác minh JWKS/JWT và lấy userinfo.
- `src/auth/profile.ts`: profile type, kiểm tra subject và validate/map userinfo.
- `src/auth/security.ts`: sinh chuỗi ngẫu nhiên, PKCE và so sánh timing-safe.
- `src/routes/public.ts`: trang chủ, health và API profile.
- `src/views/page.ts`: render các trạng thái HTML và escaping.
- `src/server.ts`: tải env và listen.
- `test/`: test cô lập.



## Current compatibility and verification (2026-10-14)

Proxy configuration update (2026-10-16): API base URLs now support path prefixes; defaults use portal `http://localhost:3000` and API `http://localhost:3000/api`. Typecheck and build passed; all 36 tests passed, including an HTTP provider fixture that serves token, userinfo and remote RSA JWKS under `/api`. Tests required expanded permissions after the sandbox blocked worker spawning with EPERM. Live portal/backend login has not been verified for this update.

The current backend implementation is the API contract for this adapter:

- Authorization Code with PKCE S256 and scopes `openid profile email`; no `offline_access` or forced consent parameter.
- Access JWT verification requires RS256, the configured client audience, UUID subject and expiry. JWKS comes only from the configured API origin. The backend does not issue `iss` or `token_use`; the adapter does not validate issuer or token purpose. This is not a claim of OIDC conformance.
- `RITA_ISSUER` is no longer read. An existing entry in local `.env` is ignored; no secret files were changed.
- Userinfo must provide all seven backend fields with valid types and a matching `_id`. Unknown fields are discarded; only employee code and phone number permit null.
- Access tokens are used only during exchange/userinfo. ID and refresh tokens are discarded. No credentials are stored in the local session or sent to the browser.
- Session expiry is the earlier of JWT expiry and five minutes after callback. The JWT expiry is authoritative even when the backend's literal `expires_in: 300` differs.
- Logout destroys only the demo session. There are no refresh, revoke or Rita ID logout requests. The refresh session created by the provider during code exchange remains until its expiry unless revoked separately.
- Node 24, MemoryStore, localhost ports and existing dependencies are unchanged. No database migration is needed. Restart the demo after updating; MemoryStore sessions are lost on restart.

Baseline before this change: typecheck and build passed; 20 of 22 tests passed. Existing failures covered the five-minute session cap and retention of the access token in the exchange result.

Final verification on 2026-10-14 for the updated local files (this directory has no Git repository): `npm run typecheck` passed; `npm test` passed all 27 tests; `npm run build` passed. The initial sandbox blocked test-worker spawning and build writes with EPERM; both commands were rerun successfully with expanded permissions.

Verification uses isolated HTTP requests, RSA signing and mocked provider responses. No live login, browser/Odoo/PostgreSQL smoke test or migration has been run. Follow the manual smoke procedure above with an appropriate account and registered client; use `MOCKUP_MODE=false` when verifying distinct real identities.
