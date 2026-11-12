# Các lỗi phát hiện bằng integration test

Kiểm tra trên Docker local riêng ngày **12/11/2026**, source tree `5e439abc2ded3f0efdefbce0941f6ce07dd0bbcf` của Kirenz. Mã nguồn ứng dụng không được sửa để làm test pass. Không tạo dữ liệu hoặc gọi API production.

| ID | Mức ưu tiên đề xuất | Request / tình huống | Kỳ vọng | Kết quả thực tế |
| --- | --- | --- | --- | --- |
| AUTH-TOKEN-TYPE | Cao | `POST /api/auth/refresh` gửi access token vào `refreshToken` | 401, token sai mục đích bị từ chối | 200, cấp cặp token mới |
| IDENTITY-USERNAME | Trung bình | B đọc friend profile của A qua User → Identity | `username` bằng username đã đăng ký | Trả email của A; display name vẫn đúng |
| SOCIAL-BLOCK-COMMENT | Cao | B tạo comment sau khi A block B | 403/404 | 201; cùng lúc GET post đã trả 404 |
| CHAT-BLOCK-DM | Cao | B tạo direct chat với A sau khi bị A block | 403 | 200, tạo/resolve conversation |
| CHAT-READ-MEMBERSHIP | Trung bình | Outsider `POST /api/messages/{conversationId}/read` | 403/404 | 200; thiếu kiểm tra membership |
| ADMIN-CONTENT-REPORT | Cao | USER gửi `POST /api/reports` cho POST có thật | 201 | 503 do luồng Feign tới API Social yêu cầu ADMIN |
| CHAT-TOPIC-MEMBERSHIP | Cao | Outsider subscribe `/topic/conversation.{id}` | Không nhận nội dung chat ngoài membership | Nhận đầy đủ tin nhắn fixture do A gửi |
| CHAT-TYPING-MEMBERSHIP | Trung bình | Outsider gửi `/app/chat.typing` vào conversation A/B | Không broadcast | B nhận typing của outsider |
| IDENTITY-USER-CREATED-PROJECTION | Cao về độ tin cậy | Identity register → Kafka `user-created` → User privacy row | Đúng 1 row từ consumer, không gọi API lazy-create | 0 row; log có `ClassNotFoundException` tên event của Identity |

Mức ưu tiên là đánh giá để người duy trì triage; báo cáo không thay thế đánh giá ảnh hưởng production.

## Tái hiện bằng bộ test

1. Dựng stack từ `compose.integration.json` theo [README](../README.md).
2. Chạy `npm test`. Collection tạo A/B/outsider riêng và tái hiện sáu lỗi HTTP trong [newman-report.json](newman-report.json). Tìm request có tiền tố `SECURITY`, `REGRESSION`, `Feign returns updated A profile` hoặc `Blocked B cannot start chat`.
3. Chạy `npm run test:ws` với environment runtime vừa tạo. [websocket-report.json](websocket-report.json) có hai lỗi subscription/typing, đồng thời chứng minh delivery hợp lệ, persist MongoDB, HTTP history và Redis presence hoạt động.
4. Chạy `npm run test:events`. [event-projection-report.json](event-projection-report.json) dùng SELECT read-only trên database owner User; không gọi API tự tạo privacy row nên không che lỗi consumer.

Mỗi suite có giới hạn thời gian và trả exit code khác 0 khi có lỗi. Không đổi assertion để xem status cho phép trái quyền là thành công.

## Bằng chứng và nguyên nhân

- `AuthService.refreshToken` chỉ kiểm tra email, expiry và chữ ký. Token được cấp khác thời lượng nhưng không có bước xác thực token dành riêng cho refresh. File: `identity-service/src/main/java/com/kirenz/identity_service/auth/service/AuthService.java:201` và `auth/security/JWTService.java`.
- `User.getUsername()` trả email để phục vụ Spring Security; profile username nằm ở `getProfileUsername()`. MapStruct map theo getter mặc định, làm response và dữ liệu enrich trả email. File: `identity-service/src/main/java/com/kirenz/identity_service/user/model/User.java:114` và `user/mapper/UserMapper.java`.
- Truy cập comment dùng kiểm tra visibility riêng, không áp dụng block như PostService. Xem [social-findings.md](social-findings.md).
- Quyền DM ở User chỉ kiểm tra allowDirectMessages/friendship, không kiểm tra block. WebSocket topic và typing không kiểm tra membership. Xem [chat-findings.md](chat-findings.md) để có đường dẫn nguồn và giới hạn từng kết luận.
- Report POST gọi `SocialModerationClient.getContent` bằng bearer USER; API Social đích yêu cầu ADMIN và fallback chuyển thành downstream unavailable. File: `admin-service/src/main/java/com/example/admin_service/report/ReportService.java:64`, `social/SocialModerationClient.java`, và Social SecurityConfig.
- User Kafka JsonDeserializer chưa map tên class event của Identity sang DTO event của User. Log runtime xác nhận consumer không load được `com.kirenz.identity_service.auth.event.UserCreatedEvent`; Notification có mapping riêng nhưng User không có.

## Ghi nhận khác

Notification của người khác bị từ chối bằng **401** và không có payload, dù token hợp lệ. Test security chấp nhận 401/403/404 kèm kiểm tra không có dữ liệu của chủ khác; đây là vấn đề phân loại lỗi HTTP cần làm rõ, không phải bằng chứng lộ notification.

HTTP read-receipt của outsider trả 200 không chứng minh trạng thái đọc của thành viên khác bị thay đổi; query hiện lọc theo user ID người gọi. Bằng chứng là thiếu authorization của operation.

Không kết luận đã kiểm tra media LiveKit thật, Google OAuth hoặc upload Cloudinary. Lần chạy này kiểm tra call orchestration và lỗi provider-unavailable; mailbox Brevo là stub local.
