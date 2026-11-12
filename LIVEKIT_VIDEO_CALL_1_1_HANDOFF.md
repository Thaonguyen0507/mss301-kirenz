# LiveKit video call 1–1 cho app social

Tài liệu để mang sang dự án khác, tách từ cách MentalBridge tích hợp LiveKit. Phạm vi: hai user gọi camera + micro, bật/tắt thiết bị, rời và kết thúc cuộc gọi. Code minh họa dùng **Java/Spring Boot + React** như repo gốc; backend khác ngôn ngữ vẫn áp dụng cùng luồng qua LiveKit server SDK tương ứng.

## 1. Cần những gì?

| Thành phần | Cần làm |
| --- | --- |
| LiveKit Cloud | Tạo project, lấy project URL, API key và API secret |
| Backend hiện có | Xác thực user, kiểm tra hai người thuộc cuộc gọi, tạo phòng và ký token |
| Frontend | Xin token từ backend, kết nối LiveKit, render camera/âm thanh và nút điều khiển |
| Luồng gọi của app | Gửi lời mời, chấp nhận/từ chối và báo kết thúc qua chat/WebSocket/push hiện có |
| Thiết bị/mạng | Camera, micro và quyền truy cập; web chạy HTTPS hoặc localhost khi phát triển |

LiveKit xử lý kết nối media/WebRTC qua hạ tầng Cloud. Không phải tự dựng signaling WebRTC, STUN/TURN hoặc media server khi dùng Cloud. Luồng mời người khác đổ chuông/chấp nhận là phần app cần nối thêm; đoạn kết nối vào phòng bên dưới không tự tạo luồng đó.

Không cần bê hệ thống lịch hẹn, thanh toán, AI, Kafka, Redis hoặc các microservice của MentalBridge sang. Webhook không bắt buộc để hai người truyền video/audio; chỉ bổ sung nếu cần server theo dõi sự kiện tham gia/rời phòng và lịch sử cuộc gọi.

## 2. Dependency

Các version dưới đây lấy từ repo đang đọc, không phải yêu cầu nâng toàn bộ dự án lên cùng version framework.

**Backend Java:** thêm vào `pom.xml` của backend đã có Spring Web và cơ chế đăng nhập:

```xml
<dependency>
    <groupId>io.livekit</groupId>
    <artifactId>livekit-server</artifactId>
    <version>0.16.0</version>
</dependency>
```

Repo gốc dùng Java 21. SDK này hỗ trợ Java dù tên repository chính thức là `server-sdk-kotlin`.

**Frontend React:**

```bash
npm install --save-exact livekit-client@2.20.1 @livekit/components-react@2.9.24
```

Code UI tùy chỉnh bên dưới dùng CSS của app, không cần package giao diện bổ sung. Nếu backend là Node.js, dùng `livekit-server-sdk` thay SDK Java; vẫn giữ cùng quy tắc cấp token/phòng.

## 3. Key và biến môi trường

Tạo project ở [LiveKit Cloud](https://cloud.livekit.io/), lấy URL và API credentials trong project. Dùng project riêng cho app đích.

```dotenv
LIVEKIT_URL=wss://YOUR_PROJECT.livekit.cloud
LIVEKIT_API_KEY=YOUR_API_KEY
LIVEKIT_API_SECRET=YOUR_API_SECRET
LIVEKIT_TOKEN_TTL=PT2M
```

- Ba giá trị đầu do bạn tự điền; `PT2M` là thời hạn token 2 phút theo định dạng Java `Duration`.
- Backend đọc từ environment của process/container. Spring không tự đọc `.env` chỉ vì file tồn tại; cần cấu hình IDE, Compose `env_file` hoặc dotenv loader của dự án đích.
- API key và API secret ở **server**. Frontend chỉ nhận `serverUrl` và token tham gia của chính user đó.
- Token đăng nhập app và token LiveKit là hai token khác nhau. Token LiveKit lưu trong RAM, không đặt vào URL, localStorage, log hoặc response cache.
- TTL giới hạn thời điểm dùng token để vào phòng; **không phải thời lượng cuộc gọi** và không tự ngắt người đang kết nối. Xem [token lifecycle](https://docs.livekit.io/frontends/reference/tokens-grants/).

## 4. Luồng tích hợp và API của app

1. A gọi B → backend tạo `callId`, `roomName` ngẫu nhiên và hai participant identity khác nhau.
2. App gửi thông báo đến B; B chấp nhận → backend cho phép cuộc gọi kết nối.
3. Mỗi người gọi `POST /api/calls/{callId}/video-access` bằng phiên đăng nhập của mình.
4. Backend kiểm tra user thuộc đúng cặp A/B, cuộc gọi đã được chấp nhận và chưa kết thúc; tạo/đảm bảo phòng giới hạn 2 người rồi cấp token riêng.
5. Hai frontend dùng cùng `serverUrl`, cùng phòng trong token, nhưng **khác identity và token** để kết nối LiveKit.
6. Frontend bật camera/micro, render video và remote audio. Khi rời thì disconnect và xóa token khỏi state.

Mapping tối thiểu lưu trong dữ liệu cuộc gọi của app:

```text
callId
callerId, calleeId
roomName = "call-" + random UUID
callerIdentity = "p-" + random UUID
calleeIdentity = "p-" + random UUID
status = RINGING | ACCEPTED | ENDED
```

Giữ nguyên room/identity khi reconnect cùng cuộc gọi. Mỗi cuộc gọi mới tạo room mới. Không dùng tên thật/email làm room hoặc identity. Không nhận `roomName`, `identity` hay quyền LiveKit do client tự khai. Giới hạn 2 người không thay thế kiểm tra membership ở backend.

Response endpoint cấp token:

```json
{
  "serverUrl": "wss://YOUR_PROJECT.livekit.cloud",
  "participantToken": "JWT_CREATED_BY_BACKEND",
  "expiresAt": "2026-11-09T12:02:00Z"
}
```

Response phải có `Cache-Control: no-store`. Dùng auth/cookie/BFF và bảo vệ CSRF theo cơ chế hiện có của app; không mở endpoint cấp token công khai.

## 5. Backend: tạo phòng và cấp token

`LiveKitVideoService.java` — đặt trong package được Spring scan. Đây là adapter LiveKit; controller/service của app phải kiểm tra quyền trước khi gọi.

```java
package example.video;

import io.livekit.server.*;
import okhttp3.OkHttpClient;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import java.util.concurrent.TimeUnit;

@Service
public class LiveKitVideoService {
    private final String url, apiKey, apiSecret;
    private final Duration ttl;
    private final RoomServiceClient rooms;

    public LiveKitVideoService(
            @Value("${LIVEKIT_URL}") String url,
            @Value("${LIVEKIT_API_KEY}") String apiKey,
            @Value("${LIVEKIT_API_SECRET}") String apiSecret,
            @Value("${LIVEKIT_TOKEN_TTL:PT2M}") String tokenTtl) {
        this.url = url;
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.ttl = Duration.parse(tokenTtl);
        if (!url.startsWith("wss://") || apiKey.isBlank() || apiSecret.isBlank()
                || ttl.compareTo(Duration.ofSeconds(30)) < 0
                || ttl.compareTo(Duration.ofMinutes(5)) > 0) {
            throw new IllegalStateException("Invalid LiveKit configuration");
        }
        var http = new OkHttpClient.Builder()
                .connectTimeout(1, TimeUnit.SECONDS)
                .readTimeout(3, TimeUnit.SECONDS)
                .callTimeout(4, TimeUnit.SECONDS)
                .retryOnConnectionFailure(false).build();
        rooms = RoomServiceClient.createClient(url, apiKey, apiSecret, () -> http, false);
    }

    public void prepareRoom(String roomName) {
        try {
            var response = rooms.createRoom(roomName, 300, 2).execute();
            if (!response.isSuccessful() || response.body() == null) throw unavailable();
        } catch (IOException exception) {
            throw unavailable();
        }
    }

    public Access issueAccess(String roomName, String participantIdentity) {
        var now = Instant.now();
        var expiresAt = now.plus(ttl);
        var token = new AccessToken(apiKey, apiSecret);
        token.setIdentity(participantIdentity);
        token.setNotBefore(Date.from(now));
        token.setExpiration(Date.from(expiresAt));
        token.addGrants(
                new RoomJoin(true), new RoomName(roomName),
                new CanPublish(true), new CanSubscribe(true),
                new CanPublishSources(List.of("camera", "microphone")),
                new CanPublishData(false), new CanUpdateOwnMetadata(false),
                new RoomAdmin(false), new RoomCreate(false), new RoomList(false),
                new RoomRecord(false), new IngressAdmin(false), new Agent(false));
        return new Access(url, token.toJwt(), expiresAt);
    }

    public void endRoom(String roomName, List<String> participantIdentities) {
        try {
            for (var identity : participantIdentities) {
                long cutoff = Instant.now().getEpochSecond() + 1;
                var result = rooms.removeParticipant(roomName, identity, cutoff).execute();
                if (!result.isSuccessful()) throw unavailable();
            }
            var result = rooms.deleteRoom(roomName).execute();
            if (!result.isSuccessful() && result.code() != 404) throw unavailable();
        } catch (IOException exception) {
            throw unavailable();
        }
    }

    private ResponseStatusException unavailable() {
        return new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Video call temporarily unavailable");
    }

    public record Access(String serverUrl, String participantToken, Instant expiresAt) {
        @Override public String toString() { return "Access[redacted]"; }
    }
}
```

`createRoom(roomName, 300, 2)` đặt empty timeout 300 giây và tối đa 2 participant; 300 không phải thời lượng call. LiveKit có thể tự tạo room lúc join, nhưng tạo rõ ràng giúp đặt giới hạn 2 người. Xem [Room service API](https://docs.livekit.io/reference/other/roomservice-api/).

**Nối vào controller của app — pseudocode, cần thay auth/repository bằng code dự án đích:**

```text
POST /api/calls/{callId}/video-access
    actor = requireAuthenticatedUser()
    call = requireAcceptedCallAndMembership(callId, actor.id)
    livekit.prepareRoom(call.roomName)
    kiểm tra lại trạng thái/membership sau thao tác mạng
    identity = actor là caller ? call.callerIdentity : call.calleeIdentity
    return HTTP 200 + Cache-Control: no-store
           + livekit.issueAccess(call.roomName, identity)
```

Serialize bước kiểm tra/cấp token với bước kết thúc theo `callId` bằng cơ chế đồng bộ/transaction hiện có, để không cấp token mới khi một request khác vừa kết thúc call. Nếu room tự đóng sau khi vắng người, lần cấp access tiếp theo phải chuẩn bị lại room với giới hạn 2.

**Rời và kết thúc:** `Rời` chỉ disconnect máy hiện tại. Nếu nút `Kết thúc` phải ngắt cả hai, thêm `POST /api/calls/{callId}/end`: xác thực thành viên, chuyển trạng thái `ENDED` để chặn cấp token mới, gọi `endRoom` với cả hai identity và báo cho client xóa state. Trên Cloud, code dùng explicit revocation cutoff rồi xóa phòng; chỉ `deleteRoom` không bảo đảm token cũ hết hiệu lực. Backend cần đồng hồ chính xác và xử lý thử lại nếu đóng phòng thất bại; không báo đã đóng media khi API provider còn lỗi. Xem [token revocation](https://docs.livekit.io/frontends/reference/tokens-grants/#token-revocation).

## 6. Frontend: component gọi video

`CallRoom.tsx` — dùng trong React phía client:

```tsx
'use client'

import {
  LiveKitRoom, RoomAudioRenderer, VideoTrack,
  useConnectionState, useLocalParticipant, useRemoteParticipants,
  useStartAudio, useTracks,
} from '@livekit/components-react'
import { Track } from 'livekit-client'
import { useState } from 'react'

export type CallAccess = {
  serverUrl: string
  participantToken: string
  expiresAt: string
}

export default function CallRoom({ access, onLeave, onError }: {
  access: CallAccess
  onLeave: () => void
  onError: () => void
}) {
  return (
    <LiveKitRoom
      serverUrl={access.serverUrl} token={access.participantToken}
      connect audio={false} video={false}
      options={{ adaptiveStream: true, dynacast: true }}
      onDisconnected={onLeave} onError={onError}
    >
      <Controls onLeave={onLeave} />
    </LiveKitRoom>
  )
}

function Controls({ onLeave }: { onLeave: () => void }) {
  const state = useConnectionState()
  const remote = useRemoteParticipants()
  const cameras = useTracks([Track.Source.Camera])
  const { localParticipant, isCameraEnabled, isMicrophoneEnabled } = useLocalParticipant()
  const { canPlayAudio, mergedProps } = useStartAudio({ props: {} })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function toggle(kind: 'camera' | 'microphone') {
    if (busy || state !== 'connected') return
    setBusy(true)
    setError('')
    try {
      if (kind === 'camera') await localParticipant.setCameraEnabled(!isCameraEnabled)
      else await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled)
    } catch {
      setError('Không mở được thiết bị. Hãy kiểm tra quyền camera/micro.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <p role="status">
        {state !== 'connected' ? `Kết nối: ${state}`
          : remote.length ? 'Đã kết nối' : 'Đang chờ người còn lại'}
      </p>
      <div className="call-videos">
        {cameras.map((track) => (
          <figure key={track.participant.identity}>
            <VideoTrack trackRef={track} />
            <figcaption>{track.participant.isLocal ? 'Bạn' : 'Người còn lại'}</figcaption>
          </figure>
        ))}
      </div>
      <RoomAudioRenderer />
      {!canPlayAudio && <button {...mergedProps} type="button">Bật âm thanh cuộc gọi</button>}
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={busy || state !== 'connected'}
        aria-pressed={isMicrophoneEnabled} onClick={() => void toggle('microphone')}>
        {isMicrophoneEnabled ? 'Tắt micro' : 'Bật micro'}
      </button>
      <button type="button" disabled={busy || state !== 'connected'}
        aria-pressed={isCameraEnabled} onClick={() => void toggle('camera')}>
        {isCameraEnabled ? 'Tắt camera' : 'Bật camera'}
      </button>
      <button type="button" onClick={onLeave}>Rời cuộc gọi</button>
    </section>
  )
}
```

CSS tối thiểu:

```css
.call-videos { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 12px; }
.call-videos figure { margin: 0; }
.call-videos video { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: #111; }
```

Cách nối vào màn hình hiện có:

- Parent giữ `const [access, setAccess] = useState<CallAccess | null>(null)`.
- Sau nút tham gia, fetch endpoint bằng auth của app và `cache: 'no-store'`; kiểm tra HTTP status và validate response trước `setAccess`.
- Khi `access !== null`, render `<CallRoom access={access} onLeave={leave} onError={handleError} />`.
- `leave` và `handleError` phải `setAccess(null)`; dùng callback ổn định qua `useCallback`. Unmount component sẽ disconnect LiveKit và dừng media. Nếu màn hình unmount trong khi fetch token đang chạy, hủy request hoặc bỏ qua kết quả muộn.
- Khi nhận sự kiện app báo call đã kết thúc, cũng xóa `access`. Token mới khi rejoin phải xin lại backend và kiểm tra quyền lại.
- Trong Next.js, import qua `dynamic(() => import('./CallRoom'), { ssr: false })` **bên trong Client Component** để media chạy ở browser.

Code này kết nối với camera/micro tắt; user chủ động bấm bật từng thiết bị. Có thể đổi `audio`/`video` sang `true` nếu muốn xin quyền/bật ngay sau thao tác tham gia. **Giữ `RoomAudioRenderer`** để nghe người còn lại; nút dùng `useStartAudio` xử lý browser chặn autoplay. API component tham khảo tại [LiveKitRoom](https://docs.livekit.io/reference/components/react/component/livekitroom/).

## 7. Nếu app đích là React Native/Expo

Backend và token giữ nguyên. Thay component web bằng native SDK. Các version trong repo:

```text
@livekit/react-native                 3.0.0
@livekit/react-native-webrtc          144.2.0
@livekit/react-native-expo-plugin     1.0.3
@config-plugins/react-native-webrtc   15.0.2
livekit-client                       2.20.1
```

Cần native development/release build, không dùng Expo Go; gọi `registerGlobals()` trước entry của app, cấu hình plugin/quyền camera-micro, xin runtime permission và quản lý `AudioSession.startAudioSession()` / `stopAudioSession()`. Đây là nhánh triển khai riêng; component web phía trên không dùng nguyên trên native. Xem [LiveKit Expo setup](https://docs.livekit.io/transport/sdk-platforms/expo/) và chọn dependency tương thích Expo/RN của app đích.

## 8. Kiểm tra khi gắn sang dự án khác

- Hai tài khoản ở hai browser/profile hoặc hai thiết bị khác nhau nghe/nhìn được nhau; bật/tắt micro/camera hoạt động.
- Người thứ ba và người chưa đăng nhập không lấy được token; client không chọn được room/identity của người khác.
- Rời màn hình giải phóng camera/micro. Mất mạng hiển thị reconnect; vào lại dùng đúng call/identity và token còn hợp lệ hoặc xin mới.
- Từ chối quyền thiết bị có thông báo và cho thử lại; có hình mà mất tiếng thì kiểm tra audio renderer/autoplay.
- Nếu hỗ trợ kết thúc cho cả hai: backend chặn token mới, ngắt cả hai và token cũ không vào lại được.

Tài liệu này không chứa key thật và chưa thực hiện cuộc gọi Cloud mới. Code được rút gọn từ tích hợp hiện có; phần auth, controller, lưu call và mời/nhận cuộc gọi phải nối vào dự án đích.

## Nguồn code trong repo gốc

- Backend SDK/token/phòng: `mentalbridge-backend/consultation-service/src/main/java/com/mentalbridge/consultation/video/LiveKitVideoProvider.java`
- Cấu hình: `mentalbridge-backend/consultation-service/src/main/java/com/mentalbridge/consultation/video/LiveKitProperties.java`
- Dependency Java: `mentalbridge-backend/consultation-service/pom.xml`
- Media web: `mentalbridge-frontend/mentalbridge/features/appointments/components/VideoMedia.tsx`
- Dependency web: `mentalbridge-frontend/mentalbridge/package.json` và lockfile
- Media native: `mentalbridge-frontend/mobile/src/video/VideoMedia.native.tsx`

Chỉ lấy adapter/config/media từ những file này; không copy các điều kiện lịch hẹn, role chuyên gia, credit hoặc xác nhận hoàn thành phiên.
