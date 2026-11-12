# Kết quả kiểm thử Kirenz

Kiểm thử ngày 12/11/2026 trên Docker local riêng, Gateway `http://localhost:18080`. Source tree `5e439abc2ded3f0efdefbce0941f6ce07dd0bbcf`; source code không được sửa trong quá trình tạo bộ test.

Collection API có **125 request**, đã qua schema Postman v2.1, Postman SDK, kiểm tra script, biến và coverage controller. Collection integration có **122 bước**, tự tạo actor và lưu token/ID từ response.

| Suite | Tổng assertion/check | Pass | Fail | Skip | Báo cáo |
| --- | ---: | ---: | ---: | ---: | --- |
| HTTP integration / cross-service | 321 | 315 | 6 | 0 | [JSON](newman-report.json) |
| STOMP/WebSocket | 13 | 11 | 2 | 0 | [JSON](websocket-report.json) |
| Identity → Kafka → User projection | 4 | 3 | 1 | 0 | [JSON](event-projection-report.json) |
| Dependency failure and recovery | 7 | 7 | 0 | 0 | [JSON](resilience-report.json) |

**Trạng thái: FAIL do còn lỗi ứng dụng.** Script trả exit code khác 0 khi có assertion fail. Các test phân quyền không được sửa để chấp nhận truy cập trái phép. Xem [findings.md](findings.md) để tái hiện từng lỗi.

PostgreSQL, MongoDB, Kafka, Redis, Eureka, HTTP Gateway và Feign chạy thật. Brevo dùng mailbox stub local; LiveKit dùng chế độ provider unavailable để kiểm tra vòng đời call/lỗi dependency. Upload Cloudinary, Google OAuth và video/audio Cloud thật chưa được chạy trong bộ local này.

Các fixture auth vẫn ở database local vì dự án chưa có API xóa account; cleanup đã xóa các post/comment/share/group/friendship do collection tạo. STOMP tạo tin nhắn riêng phục vụ kiểm tra. Không dùng dữ liệu production.

Import ba tệp collection/environment tại thư mục gốc; xem [README](../README.md) để chạy lại.
