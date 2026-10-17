# Luồng 1: Login OAuth 2.0 và tích hợp guard

[README](../../README.md) · [Kiến trúc](../../ARCHITECTURE.md) ·
[Tiếp theo: private API](02-private-resource-request.md)

## Mục đích và đầu vào

Sau khi đăng nhập Rita Võ ID, backend example sở hữu cặp token; frontend chỉ nhận cookie session
ID. Middleware guard dùng phiên đó để xác thực trước logic nghiệp vụ. Không lưu user/password
riêng và không dùng user `_id` làm session ID.

Điều kiện: confidential client đã có client ID/secret phía server, callback đăng ký khớp
`APP_BASE_URL/auth/callback`, Rita ID portal/backend hoạt động, Express session middleware đã
được mount. Cookie login attempt phải quay lại cùng browser khi callback.

## Các bước xử lý

1. `GET /auth/login`: strategy tạo state và PKCE verifier ngẫu nhiên, hạn attempt 10 phút.
   Lưu pending attempt/CSRF trong Express session và đăng ký PendingClaims; save trước redirect.
2. Redirect portal `/oauth/authorize` với client ID, callback, `response_type=code`, scope
   `openid profile email`, state và challenge S256. Client secret không đi qua browser.
3. Rita ID xử lý login/consent, portal redirect browser về callback với code/state hoặc error.
4. Callback đối chiếu state, expiry, session sở hữu attempt và trạng thái claim; claim một lần
   trước các bước async để callback đồng thời không đổi code hai lần. Kiểm tra deny/missing code.
5. OAuthClient POST `/auth/oauth/token` bằng Axios với grant authorization_code, code/verifier,
   redirect URI và client credentials. JOSE xác minh access JWT qua JWKS; gọi userinfo và kiểm tra
   subject khớp JWT. ID token không được dùng.
6. Sau xác minh thành công, thử đóng/revoke phiên OAuth cũ nếu có, regenerate Express session ID.
   Lưu authorization vào `OAuthSessions.add(req.sessionID, ...)`; lưu `oauthId`, CSRF mới,
   deadline và cookie maxAge vào Express session rồi save.
7. Browser nhận cookie `rita_example.sid` HttpOnly, SameSite=Lax, Secure khi HTTPS. Cookie chứa
   session ID được ký, không chứa token hoặc profile. `oauthId` bằng session ID mới.
8. Callback redirect `/`; EJS render shell và metadata phiên. Axios gọi `/api/me` qua guard để
   tải profile. JSON callback tùy chọn chỉ trả `{ profile, expiresAt }`, vẫn tạo browser session.

```mermaid
sequenceDiagram
    participant B as Browser
    participant A as Strategy và routes
    participant E as Express session
    participant P as Rita ID portal
    participant R as Rita ID backend
    participant S as OAuthSessions
    B->>A: GET /auth/login
    A->>E: Lưu state, verifier, CSRF
    A-->>B: Redirect authorize với PKCE
    B->>P: Login và consent
    P-->>B: Redirect code và state
    B->>A: GET /auth/callback
    A->>A: Kiểm tra state và claim attempt
    A->>R: POST /auth/oauth/token
    R-->>A: Access token và refresh token nếu có
    A->>A: Xác minh JWT qua JWKS
    A->>R: GET /auth/oauth/userinfo
    R-->>A: Profile
    A->>E: Regenerate session ID
    A->>S: Lưu token, identity và deadline
    A->>E: Lưu oauthId, CSRF và deadline
    A-->>B: Set-Cookie session ID, redirect /
    B->>A: GET / rồi Axios GET /api/me
    Note over B,A: Request profile đi qua guard; không trả token cho browser
```

## Gắn middle layer guard

`RitaAuthGuard.handle` là Express middleware, tương đương vai trò guard/decorator về thứ tự xử
lý nhưng không sử dụng cú pháp decorator NestJS. `createApp()` đã khởi tạo và chia sẻ một
OAuthClient, OAuthSessions, PendingClaims cho strategy/routes/guard.

Ví dụ mở rộng router nhận `sessions` từ app:

```ts
import { Router } from 'express';
import { RitaAuthGuard } from '../../src/auth/rita-auth.guard.js';
import type { OAuthSessions } from '../../src/auth/oauth-sessions.js';

// Điều chỉnh đường dẫn import theo vị trí file router thực tế.
export function createOrdersRouter(sessions: OAuthSessions) {
  const router = Router();
  const auth = new RitaAuthGuard({ sessions });
  router.get('/api/orders', auth.handle, (req, res) => {
    const subject = req.auth!.profile.sub;
    res.json({ subject }); // Handler chỉ chạy sau khi guard thành công.
  });
  return router;
}
```

Mount session middleware trước router, truyền cùng store đang được strategy ghi token.
Không tạo store mới ở mỗi request và không đặt guard trước `/auth/callback`.
Guard gắn `req.auth = { profile, expiresAt }`, gọi `next()` khi thành công. Với API nên giữ chế độ
401 mặc định; chế độ `unauthenticated: 'redirect'` chỉ redirect lỗi 401 tới `/auth/login`.

## Kết quả và lỗi

| Trường hợp | Kết quả |
| --- | --- |
| Thành công | Phiên mới, cookie mới; token chỉ phía backend |
| State thiếu/sai/hết hạn/đã claim/bị hủy | 400 invalid_state; không đổi code |
| Người dùng deny hoặc thiếu code | 400 access_denied/missing_code; không tạo phiên mới |
| Cấu hình client/scope bị từ chối | 502 integration_error |
| Exchange/JWT/userinfo không hoàn tất | 502 authentication_failed; cố revoke token vừa nhận nếu có |
| Logout trong lúc callback đang chạy | Hủy claim, không phục hồi identity; cố revoke token vừa cấp |

Deny/callback lỗi trước khi thay phiên không tự xóa identity cũ còn hiệu lực. Cookie phiên mới
khác cookie login attempt để tránh giữ session ID trước xác thực.

> Kho RAM hiện tại chỉ dành cho demo. Production cần lưu cả token, Express session và ánh xạ
> bền vững, giữ SESSION_SECRET ổn định. Xem [lưu trữ bền vững](../../ARCHITECTURE.md#luu-tru-ben-vung)
> cho Redis/PostgreSQL và yêu cầu pending claims khi chạy nhiều instance.

## Source và kiểm chứng

- [Strategy](../../src/auth/rita-auth.strategy.ts), [pending claims](../../src/auth/pending-claims.ts),
  [session](../../src/auth/session.ts), [guard](../../src/auth/rita-auth.guard.ts).
- [App tests](../../test/app.test.ts): state/PKCE, callback replay, session regeneration, JSON callback.
- [Lifecycle tests](../../test/lifecycle.test.ts): re-login, logout/callback race.
- [Guard tests](../../test/rita-auth.guard.test.ts): thiếu phiên, expiry, req.auth, redirect mode.
