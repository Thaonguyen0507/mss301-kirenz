# Demo Postman: success, block và unblock

Import `Kirenz-DM-Block-Demo.postman_collection.json` và `Kirenz-DM-Block-Demo.postman_environment.json`. Chọn environment **Kirenz | DM Block Demo**; `base_url` phải là `http://localhost:18080`.

Gateway, Identity, User, Chat, PostgreSQL, MongoDB và Redis phải đang chạy trong stack `kirenz-integration`. User-service cần được build từ nhánh đã sửa lỗi block. Các request tạo tài khoản test mới; không sử dụng tài khoản production.

## Chạy demo

1. Run folder **00 SETUP** một lần. Nó tạo A/B mới, đăng nhập, lưu token/UUID và tạo hội thoại. Không cần copy token hoặc nhập ID thủ công.
2. Mở folder **01 SUCCESS**. Chạy request `01.0`: HTTP 200, `data:true`, nghĩa là A được phép liên lạc B. Sau đó Run ba request `01.1` → `01.3`: A gọi → B nhận → A kết thúc, trạng thái `RINGING` → `ACCEPTED` → `ENDED`.
3. Mở folder **02 NEGATIVE**. B block A bằng token B. Hai request hỏi quyền trả **200 + `data:false`**. Request A gọi B và B gọi A đều trả **403 + `success:false`**; mở lại direct conversation cũng 403.
4. Mở folder **03 RESTORE**. B unblock A. Quyền trở lại `data:true`; Run các bước Start → Accept → End để chứng minh chức năng hoạt động lại.

**HTTP 403 đúng kỳ vọng vẫn là test PASS.** Đây là trường hợp nghiệp vụ bị từ chối có chủ đích. Test đỏ chỉ xuất hiện nếu backend làm khác kỳ vọng, ví dụ vẫn trả 200 sau block.

## Câu giải thích lúc demo

“Ở lượt đầu, B cho phép DM nên Chat-service gọi User-service qua OpenFeign và nhận true, cuộc gọi được tạo. Em chỉ thay đổi một điều kiện là B block A; privacy vẫn cho phép mọi người nhưng quyền trả false và Chat từ chối 403 ở cả hai chiều. Khi B unblock, cùng luồng gọi hoạt động lại. Kịch bản này kiểm tra sự tích hợp giữa policy của User-service và nghiệp vụ Chat-service qua API thật.”

## Lưu ý khi trình bày

- Chỉ chạy request đăng ký A đầu tiên khi muốn tạo một bộ demo mới; request này reset các biến demo. Khi demo tiếp tục, không bấm lại đăng ký A giữa luồng.
- Start → Accept phải trong 60 giây. Sau Accept, kết thúc sớm hơn heartbeat timeout 45 giây; cách dễ nhất là Run ba request liên tiếp. Nếu đã quá hạn, gửi Start lại trước khi Accept.
- Kết thúc cuộc gọi của folder 01 trước khi chuyển sang block. Nếu bỏ dở có thể còn active call, dẫn đến 409 khi thử bước tiếp theo.
- Token có hạn 15 phút; nếu 401, chạy lại hai request Login A/B trong folder 00. Không đăng ký lại nếu chỉ cần refresh phiên đăng nhập.
- Không có request `video-access`: demo này kiểm tra nghiệp vụ và integration API, không truyền camera/audio.
- Tài khoản và lịch sử demo còn trong database local vì chưa có API xóa tài khoản. Token/mật khẩu chỉ nằm trong environment runtime; không export bản có giá trị để commit.
