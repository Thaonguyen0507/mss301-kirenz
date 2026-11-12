# Kirenz: Postman và kiểm thử tích hợp

Bộ kiểm thử đối chiếu với source tree `5e439abc2ded3f0efdefbce0941f6ce07dd0bbcf` của Kirenz, gồm Identity, User, Social, Chat, Notification, Admin, API Gateway và Eureka.

| Tệp | Mục đích |
| --- | --- |
| `Kirenz-API.postman_collection.json` | Danh mục các HTTP request theo controller/service, có body, query, auth và assertion cơ bản. |
| `Kirenz-Integration.postman_collection.json` | Các luồng có thứ tự: tạo actor, gọi API, lưu ID/token, kiểm tra tác động giữa service và dọn dữ liệu fixture. |
| `Kirenz-Local.postman_environment.json` | Environment mẫu cho Docker local; không chứa credential thật. |
| `compose.integration.json` | Stack riêng `kirenz-integration`, database và volume riêng, cổng chỉ bind `127.0.0.1`. |
| `modules/*.json` | Danh mục endpoint/DTO và ghi chú nguồn dùng để generate collection. |
| `scripts/test-websocket.mjs` | Kiểm thử STOMP/WebSocket thực tế qua Gateway, kết hợp API và Redis presence. |
| `reports/` | Báo cáo schema/coverage, Newman và WebSocket. |
| `.local/` | Dữ liệu runtime riêng tư: token, mật khẩu fixture và environment sau khi chạy. Được bỏ qua bởi Git. |

## 1. Khởi động stack local

Cần Node.js 22, Docker Desktop/Linux engine đang chạy và source Kirenz có các thư mục service cùng `spring-service.Dockerfile`. Source không cần checkout vào thư mục bộ kiểm thử. Đặt `KIRENZ_SOURCE_DIR` đúng đường dẫn máy bạn.

Ví dụ PowerShell trên Windows:

```powershell
cd D:\SEP490\mentalbridge-repo\kirenz-postman
$env:KIRENZ_SOURCE_DIR = 'D:/Kirenz-platform'
$docker = 'C:/Program Files/Docker/Docker/resources/bin/docker.exe'

npm.cmd ci
npm.cmd run build
npm.cmd run validate

& $docker compose -p kirenz-integration -f compose.integration.json build
& $docker compose -p kirenz-integration -f compose.integration.json up -d
& $docker compose -p kirenz-integration -f compose.integration.json ps
```

Dùng `npm.cmd` trên Windows để không bị chặn bởi PowerShell execution policy của `npm.ps1`. Trên Linux/macOS dùng `npm`, `docker` và đặt `KIRENZ_SOURCE_DIR` theo shell tương ứng.

`npm run build` generate collection/environment từ inventory; `npm run validate` kiểm tra schema Postman, script và mức bao phủ endpoint. Đây là kiểm tra cấu trúc bộ test, chưa chứng minh service chạy đúng.

Mỗi service có image `kirenz-it-*:2af12e5`, database/volume riêng của Compose project. Bộ test không dùng file `.env` production của repo. PostgreSQL, MongoDB, Kafka, Redis, Eureka, Gateway và các business service đều chạy thật.

Các cổng chính:

| Thành phần | URL local |
| --- | --- |
| API Gateway | `http://localhost:18080` |
| Identity / User / Social | `http://localhost:18081` / `18082` / `18083` |
| Chat / Notification / Admin | `http://localhost:18084` / `18085` / `18086` |
| Eureka | `http://localhost:18761` |
| Mailbox stub | `http://localhost:18090` |

Nếu service chưa sẵn sàng:

```powershell
& $docker compose -p kirenz-integration -f compose.integration.json logs --tail 120 identity-service user-service social-service chat-service notification-service admin-service api-gateway
```

## 2. Chạy integration bằng Newman

Sau khi cài dependency, có thể chạy trọn bộ bằng một lệnh:

```powershell
npm.cmd run local -- --source D:/Kirenz-platform
```

Lệnh này build/validate collection, dựng Docker, chạy HTTP, WebSocket, Kafka projection và test dependency failure/recovery. Nó giữ container/volume để kiểm tra và trả exit code khác 0 nếu có lỗi ứng dụng. Kết quả thực chạy nằm trong [TEST-RESULTS.md](reports/TEST-RESULTS.md), chi tiết lỗi trong [findings.md](reports/findings.md).

Hoặc chạy từng suite:

```powershell
npm.cmd test
npm.cmd run test:ws
npm.cmd run test:events
node scripts/test-resilience.mjs
node scripts/summarize.mjs
```

`npm test` chờ Gateway và các service đăng ký Eureka, tạo actor quản trị test, rồi chạy collection integration theo thứ tự. Runner kiểm tra URL loopback và nhãn Compose project trước khi cấp quyền ADMIN cho đúng row fixture trong PostgreSQL local. Đây là bước chuẩn bị dữ liệu test; public registration vẫn chỉ tạo USER.

Collection tạo A, B và outsider bằng email/username riêng cho từng `run_id`. Login thu token thật; các request tiếp theo dùng token và ID do API trả về. Không sửa account hay nội dung người dùng có sẵn.

Các luồng chính:

- Đăng ký, login, OTP thực sinh trong Redis, profile và refresh token.
- User gọi Identity qua Feign để tìm kiếm/enrich profile và quan hệ bạn bè.
- Friendship, privacy và block tác động đến quyền truy cập Social/Chat.
- Post/comment/reaction/share qua Social; notification được tạo qua Kafka và đọc bằng API.
- Direct/group conversation, quyền thành viên, vòng đời video call và lỗi provider.
- Admin gọi Identity/Social, audit moderation, report workflow và dashboard tổng hợp.
- STOMP connect, chat message, read receipt, typing, subscription privacy và Redis presence.

API catalog không phải luồng chạy tuần tự: **không chọn Run toàn bộ collection API Reference**. Các request upload/Google/provider hoặc internal cần dữ liệu và quyền riêng. Dùng integration collection để bootstrap fixture và chạy các bước phụ thuộc đúng thứ tự.

## 3. Import vào Postman

Import ba tệp:

1. `Kirenz-API.postman_collection.json`.
2. `Kirenz-Integration.postman_collection.json`.
3. `Kirenz-Local.postman_environment.json`.

Chọn environment **Kirenz | isolated Docker local**. Sau khi `npm test` đã chuẩn bị fixture, có thể import thêm `.local/runtime.postman_environment.json` để thao tác request riêng bằng token/ID local hiện có.

Nếu chạy integration trực tiếp bằng Collection Runner, chạy từ folder `00 Bootstrap` đến `99 Cleanup` theo đúng thứ tự. Admin folder cần `admin_access_token`; bootstrap quản trị tự động nằm trong `npm test`, không nằm trong public API. Folder admin sẽ skip khi thiếu token này. Trước khi chạy lại thủ công, xóa `run_id`, email/username/password và các ID/token fixture cũ, hoặc import lại environment mẫu để tạo bộ actor mới.

Không tái dùng email fixture cũ: implementation đăng ký hiện tại có thể xóa/tạo lại account chưa verify khi đăng ký cùng email. Không chạy register với account thật.

## 4. Phạm vi provider và dữ liệu test

**Email:** Identity chạy nguyên code gửi OTP nhưng `BREVO_BASE_URL` trỏ đến HTTP mailbox stub local. Stub nhận email, collection lấy OTP từ HTML rồi gọi API verify. Kiểm thử này xác minh Identity → HTTP provider boundary → Redis → Identity DB; không gửi thư qua Brevo thật.

**LiveKit:** mặc định cấu hình URL không thể truy cập và credential giả lập riêng cho test. Bộ test kiểm tra invitation, accept/decline/end, authorization và phản hồi 503 khi lấy media access. Nó **không chứng minh video/audio hoặc Cloud media đã kết nối thành công**. Muốn test Cloud thật cần một môi trường test/provider riêng; các request tương ứng có trong API catalog.

**Google và upload media:** request được cung cấp trong catalog nhưng cần Google ID token hợp lệ hoặc Cloudinary test credentials/file ảnh. Không xem các request này là đã pass khi chỉ validate collection.

**Database và broker:** dùng PostgreSQL/MongoDB/Kafka/Redis thật, dữ liệu nằm trong stack local riêng. Một số endpoint tạo defaults khi đọc; assertion liên service cần kiểm tra giá trị trả về, không chỉ HTTP 200. Dashboard cũng có `partialData` để thể hiện dependency thiếu.

Collection cleanup gọi các API xóa post/comment/group/friendship fixture mà dự án hỗ trợ. Post dùng soft delete; notification, account, report, audit và một số row fixture vẫn còn trong database test. Dữ liệu chỉ nằm trong volume của project local riêng.

**Kiểm thử lỗi dependency có kiểm soát:** chạy `node scripts/test-resilience.mjs` sau Newman/WebSocket, khi không có suite khác đang dùng stack. Script kiểm tra URL loopback và nhãn container thuộc đúng `kirenz-integration`, rồi chỉ dừng `identity-service` để xác nhận Admin Dashboard vẫn trả HTTP 200 với `partialData=true` và `unavailableComponents` có `identity`. Khối `finally` luôn khởi động lại cùng container, chờ health và dashboard phục hồi. Stack cần `ADMIN_DASHBOARD_CACHE_TTL=PT0S`; script từ chối inject lỗi nếu thiếu thiết lập này hoặc baseline đang degraded. Báo cáo ở `reports/resilience-report.json` ghi cả thao tác stop/start và kết quả phục hồi. Không chạy đồng thời với Newman/WebSocket và không dùng trên môi trường chung.

Dừng stack nhưng giữ dữ liệu:

```powershell
& $docker compose -p kirenz-integration -f compose.integration.json down
```

Xóa toàn bộ dữ liệu của **riêng stack test** khi cần bắt đầu sạch:

```powershell
& $docker compose -p kirenz-integration -f compose.integration.json down --volumes
```

## 5. Báo cáo và cách đọc lỗi

- `reports/collection-coverage.json`: số endpoint source đã được đưa vào API catalog.
- `reports/newman-report.json`: kết quả từng request/assertion đã loại JWT khỏi thông báo.
- `reports/newman-junit.xml`: báo cáo JUnit cho CI.
- `reports/websocket-report.json`: kết quả STOMP/WebSocket và các finding liên quan.
- `reports/event-projection-report.json`: Identity → Kafka → User, kiểm tra row bằng SELECT read-only để tránh API lazy-create che lỗi consumer.
- `reports/resilience-report.json`: lỗi Identity có kiểm soát, phản hồi fallback của Admin và xác nhận khởi động/phục hồi.
- `reports/TEST-RESULTS.md` và `reports/summary.json`: kết quả tổng hợp; `reports/findings.md` có request tái hiện.
- `.local/runtime.postman_environment.json`: environment riêng tư sau run, dùng cho WebSocket hoặc debug request local.

`npm test` và `npm run test:ws` trả exit code khác 0 khi có assertion fail. Không đổi status kỳ vọng chỉ để làm xanh một lỗi ứng dụng.

Các case mang nhãn `SECURITY` hoặc `REGRESSION` kiểm tra hành vi cần có: access token không được dùng thay refresh token; outsider không đọc được notification/chat; người bị block không tương tác nội dung; USER có thể gửi report nội dung hợp lệ qua admin-service. Nếu ứng dụng vi phạm, báo cáo ghi fail để giữ lại bằng chứng. Kết quả thực chạy cần đọc trong report của lần chạy tương ứng.

Chỉ chia sẻ environment mẫu và report đã rà soát. Không export token/mật khẩu trong `.local`, không commit runtime environment, không đưa credential provider thật vào collection. Runner được thiết kế cho Docker local và từ chối URL ngoài loopback; không chạy bộ fixture/moderation này trên `kirenz.online` hoặc production.
