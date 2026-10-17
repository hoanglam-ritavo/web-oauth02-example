# Rita OAuth Example

Ứng dụng Express + TypeScript minh họa **Login with Rita Võ** cho web có backend riêng
(confidential client): login/consent, callback, phiên local, refresh rotation và revoke/logout.
Chỉ dùng development, một tiến trình, không database. Production bị chặn.

## Chạy local

Yêu cầu Node.js 24 và npm; Rita ID backend và developer portal đang hoạt động.
Login Rita ID hiện xác thực trực tiếp HRM database bằng tài khoản/nhân viên đang active.
Backend cần cả database internal và HRM có schema phù hợp. Demo không tự khởi động hoặc sửa chúng.

1. Dùng tài khoản có quyền developer để tạo client trên portal. Client mặc định là
   confidential; backend tự gán scopes `openid`, `profile`, `email`.
2. Đăng ký chính xác callback **http://localhost:3003/auth/callback**, không thêm slash cuối.
3. Ghi client ID và secret trả về lúc tạo vào môi trường server. Public client không phù hợp
   với example này: backend từ chối public client gửi secret.
4. Cài dependencies và tạo cấu hình nếu chưa có:

```powershell
npm ci
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Không ghi đè .env hiện có. Dùng chuỗi ngẫu nhiên cho SESSION_SECRET, thay placeholders của client.
Không commit hoặc gửi secret vào browser/log.

```powershell
npm run dev
```

Mở **http://localhost:3003**. Không trộn localhost và 127.0.0.1 trong cùng luồng.

## Cấu hình

| Biến | Mặc định / yêu cầu |
| --- | --- |
| NODE_ENV | development/test; production bị chặn |
| PORT | 3003 |
| APP_BASE_URL | http://localhost:3003 |
| RITA_PORTAL_URL | http://localhost:3000 |
| RITA_API_URL | http://localhost:3000/api |
| RITA_CLIENT_ID | Bắt buộc, confidential client |
| RITA_CLIENT_SECRET | Bắt buộc, chỉ dùng phía server |
| SESSION_SECRET | Bắt buộc, ngẫu nhiên và ít nhất 32 ký tự |
| SESSION_MAX_AGE_HOURS | 8; số giờ lớn hơn 0, tối đa 24, cho phép phần thập phân |

APP_BASE_URL và RITA_PORTAL_URL là origin HTTP(S), không path/query/fragment/credentials.
RITA_API_URL cho phép path prefix, bỏ slash cuối, không query/fragment/credentials.
Đổi port thì đồng bộ PORT, APP_BASE_URL và callback đã đăng ký. Placeholders bị từ chối.

Browser đến portal /oauth/authorize. Server gọi các endpoint OAuth và JWKS qua RITA_API_URL:

| Cách nối | RITA_API_URL |
| --- | --- |
| Qua rewrite /api của developer portal | http://localhost:3000/api |
| Trực tiếp backend, không thêm /api | http://localhost:4000 |

Portal proxy phải chuyển nguyên body/Authorization, không redirect hoặc cache token/userinfo,
không ghi credentials hay callback query vào log. Demo không cần CORS cho token requests vì
chúng chạy server-to-server. RITA_ISSUER cũ bị bỏ qua; không có issuer giả định.

Server chỉ listen 127.0.0.1. HTTPS local cần TLS reverse proxy trên loopback và
X-Forwarded-Proto; app chỉ bật trust proxy loopback khi APP_BASE_URL là HTTPS.
Cookie rita_example.sid là HTTP-only, SameSite=Lax, Path=/, không Domain và Secure khi HTTPS.
Cookie không cách ly theo port; tên riêng tránh đụng cookie Rita ID. Không mở demo ra mạng.

## Hợp đồng với Rita ID hiện tại

- Authorization Code + PKCE S256; scope yêu cầu openid profile email. Confidential client
  vẫn bắt buộc secret dù có PKCE. Không dùng offline_access hoặc giả định forced consent.
- Portal giữ state/PKCE qua login/consent. Backend authorize/consent trả JSON
  { redirectUri, code, state }; portal thực hiện browser redirect về callback của demo.
- Token request dùng JSON tại POST /auth/oauth/token. Refresh dùng grant_type=refresh_token,
  refresh_token và client credentials. Không dùng /auth/refresh hoặc Rita ID cookies.
- Revoke dùng POST /auth/oauth/revoke với token là refresh token và client credentials;
  thành công có thể không có response body.
- Backend rotate refresh token, phát hiện reuse và revoke cả OAuth session. Refresh không
  gia hạn thời hạn tuyệt đối của OAuth session. Backend đồng bộ profile HRM khi refresh;
  nhân viên mất/inactive hoặc token/session không hợp lệ có thể trả invalid_grant.
- 503 temporarily_unavailable của backend biểu thị HRM lỗi tạm thời và transaction chưa
  tiêu thụ refresh token. Lỗi network hoặc 500 không mang bảo đảm đó.
- Userinfo có _id, name, email, employee_id, phone_number, is_developer, groups.
  Demo map _id sang sub. employee_id là mã nhân viên; employee_id/phone_number có thể null.
  Group là EMPLOYEE/CUSTOMER/ENTERPRISE; developer là flag riêng, không phải group thứ tư.
  Các group được parse không có nghĩa hệ thống hỗ trợ onboarding mọi group.
- Backend chưa lọc field userinfo theo scopes hoặc enforce audience/scope đầy đủ ở resource API.
  Demo tự xác minh audience client ID, chữ ký RS256, expiry và UUID subject qua JWKS đã cấu hình.
  Subject userinfo phải trùng JWT; refresh không được đổi người dùng.
- ID token bị bỏ qua. Đây là adapter theo hợp đồng Rita ID, không phải client OIDC chuẩn;
  không giả định issuer, discovery hoặc token purpose chưa được provider hỗ trợ.
- MOCKUP_MODE hiện không điều khiển login/profile. Không cần cấu hình flag này trong demo.

## Vòng đời và concurrency

Login tạo state và verifier ngẫu nhiên; pending attempt tối đa 10 phút, một attempt mỗi browser
session. Callback claim attempt một lần trước await; callback đồng thời không đổi code hai lần.
Deny hoặc callback lỗi không tự xóa identity cũ còn hiệu lực. Login thành công thay session ID
và cố gắng revoke OAuth session cũ.

Kho OAuthSessions riêng giữ access/refresh token và profile trong RAM. Express session chỉ
giữ tham chiếu theo session ID, CSRF, deadline và pending login. Identity/req.auth chỉ chứa
profile và expiresAt của access JWT; không serialize Authorization/TokenSet ra client.
Mọi response no-store; HTML escape các field; Helmet đặt security headers.
Không log token, secret, callback query hay profile.

Có ba mốc thời hạn khác nhau:

| Mốc | Ý nghĩa |
| --- | --- |
| accessExpiresAt | Expiry từ JWT đã xác minh, không suy từ expires_in |
| sessionExpiresAt | Hạn tuyệt đối local, mặc định 8 giờ từ callback; refresh không kéo dài |
| OAuth session phía Rita ID | Do backend quyết định; response không cung cấp hạn refresh để demo hiển thị |

Cookie và server cùng giới hạn phiên local. Nếu không có refresh token, phiên kết thúc không
muộn hơn hạn access token. Khi local hết hạn, timer cleanup thử revoke và xóa credentials
ngay cả khi browser không quay lại; timer này không refresh nền. Restart mất mọi dữ liệu RAM;
các phiên provider chưa revoke có thể tồn tại đến khi hết hạn.

Request tới / hoặc /api/me tự refresh khi access token còn dưới 30 giây, kể cả đã hết hạn.
Nút Refresh ngay chủ động rotate trước hạn. Các request đồng thời dùng chung một promise;
request sau dùng replacement token trong kho, không đọc bản cũ từ Express session.

Sau response refresh hợp lệ, kho ghi token mới trước khi verify JWT/lấy userinfo.
Nếu bước userinfo lỗi tạm thời, không dùng profile cũ để phục vụ protected request;
sau cooldown thử verify/userinfo bằng access token mới, không rotate thêm.
refreshCount/lastRefreshAt chỉ cập nhật khi toàn bộ bước xác minh hoàn tất.
Trong lúc verificationPending, accessExpiresAt vẫn là hạn của JWT đã xác minh gần nhất.

## Lỗi và logout

| Tình huống | Hành vi |
| --- | --- |
| State thiếu/sai/hết hạn, deny hoặc thiếu code | 400; không đổi code hoặc không tạo phiên |
| invalid_grant, token hết hạn/subject sai | 401 ở API; phiên không còn dùng được, login lại |
| invalid_client hoặc lỗi cấu hình grant/scope | integration_error, 502; không redirect lặp |
| Backend trả đúng 503 temporarily_unavailable | Giữ token, cooldown 5 giây; Retry-After và thử lại có kiểm soát |
| Timeout/network/response hỏng/500 khi refresh | Không retry token cũ; kết thúc phiên, thử revoke bằng token đang giữ |
| Userinfo/JWKS lỗi tạm thời sau rotation | 503, cooldown 5 giây; giữ replacement để xác minh lại |
| Manual refresh khi không có refresh token | 409 refresh_unavailable |
| CSRF thiếu/sai | 403 invalid_csrf |
| Revoke thất bại | Vẫn xóa phiên local; trang login báo chưa xác nhận được revoke |

Không tự retry token endpoint. Với manual refresh lỗi 503 trước rotation, access token cũ còn
đủ hạn vẫn có thể dùng ở request thông thường; yêu cầu refresh tiếp theo phải chờ cooldown.
Nếu access token thay thế hết hạn trong lúc chờ xác minh, kết thúc phiên và yêu cầu login lại.

Logout đánh dấu phiên đang đóng trước await, chặn refresh mới, đợi refresh đang chạy rồi revoke
token mới nhất. Callback đang chạy bị hủy và cố gắng revoke token vừa cấp; callback/refresh muộn
không khôi phục identity. Không lưu hàng đợi retry revoke. Revoke lỗi vẫn dọn credentials.

Logout demo **không logout SSO Rita ID**. Backend revoke OAuth session ngăn refresh tiếp theo,
nhưng không lập tức vô hiệu access JWT đã phát hành. Login lại có thể không cần mật khẩu nếu
phiên SSO còn hiệu lực. Không có nút logout toàn hệ thống.

## Routes và cách tái sử dụng

| Method | Path | Kết quả |
| --- | --- | --- |
| GET | / | Login hoặc profile + trạng thái phiên; tự refresh khi cần |
| GET | /auth/login | Redirect portal với state/PKCE |
| GET | /auth/callback | Xử lý code/error, tạo phiên rồi redirect / |
| GET | /api/me | Profile JSON; tự refresh; 401/502/503 khi không phục vụ được |
| GET | /api/session | Metadata an toàn, không kích hoạt refresh |
| POST | /auth/refresh | CSRF form, refresh thủ công, redirect 303 về / khi thành công |
| POST | /auth/logout | CSRF form, revoke + xóa phiên, redirect 303 |
| GET | /health | {"status":"ok"}; không gọi upstream |

/api/session trả đúng accessExpiresAt, sessionExpiresAt, canRefresh, scopes, refreshCount,
lastRefreshAt, verificationPending. Timestamp là epoch milliseconds, lastRefreshAt ban đầu null.
Không chứa token, session ID, CSRF hay secret. /api/me giữ nguyên contract profile với sub.

createApp(config, { callbackResponse: "json" }) vẫn hỗ trợ callback JSON { profile, expiresAt }.
expiresAt là hạn access JWT; xem /api/session cho hạn local. JSON mode vẫn cần browser session
đã bắt đầu bằng /auth/login, không phải API nhận code tùy ý. Callback error trả mã đã lọc:
invalid_state/access_denied/missing_code (400), authentication_failed/integration_error (502),
internal_error (500). Các API route trả { error }; lỗi của form routes trả HTML an toàn.

RitaAuthStrategy và RitaAuthGuard là Express classes, không phải Passport/NestJS providers.
Khi tái sử dụng, tạo một OAuthClient, một OAuthSessions và một pendingClaims registry cho mỗi
app; truyền cùng instances vào strategy/router/guard. Middleware session phải đứng trước guard.
Guard được tạo bằng new RitaAuthGuard({ sessions }); chế độ unauthenticated: "redirect" chỉ
redirect lỗi 401 tới /auth/login, không redirect lỗi cấu hình hoặc upstream tạm thời.
Không đặt guard trước callback. Guard không nhận Bearer từ browser, không kiểm tra quyền theo
group và không thay thế CSRF cho thao tác ghi. Không dùng nhiều worker/instance với kho RAM này.

| Source | Trách nhiệm |
| --- | --- |
| [oauth-client.ts](src/auth/oauth-client.ts) | Exchange/refresh/revoke, JWT/JWKS, userinfo và lỗi upstream đã lọc |
| [oauth-sessions.ts](src/auth/oauth-sessions.ts) | Nguồn credentials duy nhất, deadline, single flight, rotation/revoke |
| [rita-auth.strategy.ts](src/auth/rita-auth.strategy.ts) | Login/callback, state và session regeneration |
| [rita-auth.guard.ts](src/auth/rita-auth.guard.ts) | Protected route và tự refresh |
| [routes.ts](src/auth/routes.ts) | Callback response, refresh/logout CSRF |
| [session.ts](src/auth/session.ts) | Express session types và cookie |
| [pending-claims.ts](src/auth/pending-claims.ts) | Claim/cancel login attempt đồng thời |
| [app.ts](src/app.ts) | Wiring, headers và error handling |
| [public.ts](src/routes/public.ts), [page.ts](src/views/page.ts) | Profile, status và form demo |
| [config.ts](src/config.ts), [server.ts](src/server.ts) | Cấu hình và entrypoint loopback |

## Kiểm chứng

```powershell
npm run typecheck
npm test
npm run build
npm start
```

Chỉ npm start/dev tải cấu hình runtime và chạy app. Tests dùng fixtures riêng, RSA thật/JWKS
giả lập, Supertest và HTTP provider local; không đọc .env hoặc gọi backend/HRM thật.

### Checklist end-to-end thủ công

Dùng client/tài khoản dành cho kiểm thử và môi trường đã có schema tương thích:

1. Browser mới: login → đăng nhập Rita ID → allow → kiểm tra profile đúng người.
2. Client chưa consent: deny → không tạo phiên demo mới.
3. /api/me có sub và bảy field profile; /api/session chỉ có metadata, không credentials.
4. Bấm Refresh ngay: refreshCount tăng, profile được đồng bộ, sessionExpiresAt không đổi.
5. Chờ gần/hết hạn access rồi tải / hoặc /api/me: tự refresh, không yêu cầu password.
6. Mở hai tab cùng phiên và gửi request gần hạn: một rotation, không vô tình revoke do replay.
7. Logout: /api/me thành 401; login lại có thể tái sử dụng SSO.
8. Trong môi trường kiểm thử có kiểm soát, kiểm tra HRM tạm lỗi, nhân viên inactive hoặc
   OAuth session bị revoke: hiển thị lỗi/phải login lại theo bảng trên.
9. Dùng SESSION_MAX_AGE_HOURS ngắn để kiểm tra local expiry; restart kiểm tra phiên RAM mất.
10. Khi cần đánh giá proxy/TLS, thực hiện lại với cấu hình tương ứng và kiểm tra Secure cookie.

Không lấy refresh token thật ra browser/log hoặc cố phát lại trên hệ thống dùng chung.
Replay, mất response, outage và concurrency được mô phỏng trong test suite; không dùng
smoke test để thay đổi tài khoản/schema hệ thống thật.

### Current verification status

Kiểm chứng ngày **2026-10-17**, commit **be0b65d** cộng working tree của thay đổi lifecycle:
npm run typecheck pass; npm test **61/61 pass**; npm run build pass; git diff --check pass;
12 local Markdown links trong README trỏ tới file tồn tại. Không thêm dependency.
Test runner/build chạy với quyền ngoài sandbox vì môi trường Windows giới hạn worker spawning
và thư mục project nằm ngoài writable roots mặc định.

Tests giữ coverage login/state/PKCE/JWT/profile/CSRF, bổ sung rotation tự động/thủ công,
single flight, HRM 503/cooldown, mất response sau commit, userinfo outage sau rotation,
đổi subject, logout/callback races, revoke lỗi, expiry cleanup, restart và không lộ credentials.
Lần kiểm tra đầu có một assertion cũ mong đợi chỉ hai upstream calls; đã cập nhật thành ba
vì logout nay gọi revoke. Không có failure còn lại trong các checks trên.

Chưa chạy browser login, live backend/HRM, TLS proxy, deployment hoặc migration.
Kết quả giả lập không chứng minh concurrency PostgreSQL hoặc end-to-end với hệ thống thật.
Backend, portal và .env runtime không được sửa trong thay đổi này.

### Historical baseline (superseded)

Ngày 2026-10-16: typecheck/build và 36 tests của phiên bản chỉ login đã pass theo ghi nhận
trước đây. Các mô tả cũ “không refresh”, phiên local tối đa 5 phút, bỏ secret khi có PKCE và
MOCKUP_MODE chọn nhân viên cố định không còn áp dụng. Đây không phải kết quả của bản hiện tại.
