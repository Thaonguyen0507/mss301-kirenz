# Chat and event-projection integration findings

Tested against the isolated `kirenz-integration` Docker project and source tree `5e439abc2ded3f0efdefbce0941f6ce07dd0bbcf`. Fixture run: `mwdmaizj8fb20b`.

- Newman report: generated **12/11/2026 21:03:08 (Asia/Saigon)**; 122 requests, 321 assertions, 315 passed, 6 failed.
- WebSocket report: started **12/11/2026 21:04:34**; 13 cases, 11 passed, 2 failed, no skips.
- Event projection report: started **12/11/2026 21:04:35**; 4 checks, 3 passed, 1 failed, no skips.
- These reruns use the same latest private runtime environment and fixture run as the Newman report. Reports contain fixture identifiers but omit authentication tokens and passwords.
- Application source was unchanged. Failed security assertions remain failures.

## CHAT-TOPIC-MEMBERSHIP — High: outsider receives private conversation messages

**Test:** `Outsider conversation-topic subscription does not leak private messages` in [websocket-report.json](websocket-report.json).

**Expected:** An authenticated user outside an A/B conversation cannot subscribe to its topic or receive its message payloads.

**Actual:** The outsider subscribed to `/topic/conversation.{conversationId}` and received the unique fixture message subsequently sent by A. B also received that message, proving the test exercised real delivery.

**Source:** [WebSocketAuthInterceptor.java](/D:/Kirenz-platform/chat-service/src/main/java/com/example/chat_service/common/config/WebSocketAuthInterceptor.java:59) validates private queue destinations but does not check membership for conversation topics. [MessageBroadcastService.java](/D:/Kirenz-platform/chat-service/src/main/java/com/example/chat_service/message/service/MessageBroadcastService.java:37) broadcasts full messages to those topics.

**Impact:** Knowing another conversation's identifier permits disclosure of live message content and metadata. Only disposable fixture messages were used to verify this.

## CHAT-TYPING-MEMBERSHIP — Medium: outsider can inject typing events

**Test:** `Outsider cannot spoof typing in A/B conversation` in [websocket-report.json](websocket-report.json).

**Expected:** An outsider cannot publish typing activity into a conversation they do not belong to.

**Actual:** The outsider sent `/app/chat.typing` with the A/B conversation identifier; B received `{userId: outsider, isTyping: true}`.

**Source:** [ChatWebSocketController.java](/D:/Kirenz-platform/chat-service/src/main/java/com/example/chat_service/message/controller/ChatWebSocketController.java:41) extracts authenticated user identity but broadcasts the supplied conversation identifier without a membership check. [MessageBroadcastService.java](/D:/Kirenz-platform/chat-service/src/main/java/com/example/chat_service/message/service/MessageBroadcastService.java:78) publishes that activity directly.

**Impact:** Unauthorized realtime activity can be injected into another conversation. This does not demonstrate unauthorized message persistence; the separate outsider-message test passed.

## CHAT-READ-MEMBERSHIP — Medium: outsider read-receipt request is accepted

**Test:** `SECURITY | Outsider cannot mark another chat read` in [newman-report.json](newman-report.json).

**Expected:** `POST /api/messages/{conversationId}/read` by a nonparticipant returns 403/404.

**Actual:** HTTP 200. The API accepted an operation targeting a conversation outside the caller's membership.

**Source:** [MessageController.java](/D:/Kirenz-platform/chat-service/src/main/java/com/example/chat_service/message/controller/MessageController.java:32) delegates directly to [ChatService.java](/D:/Kirenz-platform/chat-service/src/main/java/com/example/chat_service/message/service/ChatService.java:257), which has no membership or existence validation before its update and broadcast.

**Impact boundary:** The update filters the status-list entry by the authenticated caller's user ID; this test does **not** prove that another participant's read status was changed. The confirmed defect is missing authorization and a successful unauthorized request.

## CHAT-BLOCK-DM — Medium: blocked user can create or resolve a direct chat

**Test:** `Blocked B cannot start chat with A` in [newman-report.json](newman-report.json).

**Expected:** After A blocks B, B's direct-conversation request targeting A returns HTTP 403.

**Actual:** HTTP 200 and a successful conversation response.

**Source:** [ConversationService.java](/D:/Kirenz-platform/chat-service/src/main/java/com/example/chat_service/conversation/service/ConversationService.java:194) calls User-service's DM permission check. [PrivacySettingService.java](/D:/Kirenz-platform/user-service/src/main/java/com/kirenz/user_service/privacy/service/PrivacySettingService.java:59) checks only receiver DM settings and friendship; default `allowDirectMessages=true` returns true without checking blocks. The check runs before existing-direct-conversation lookup, so conversation reuse is not the cause.

**Impact:** Cross-service messaging authorization ignores the block relationship. Video-call start reuses the same permission helper; that potential extension is source-derived and was not separately asserted in this run.

## IDENTITY-USER-CREATED-PROJECTION — High reliability: Kafka user projection is absent

**Test:** `Identity user-created Kafka event creates exactly one User privacy projection` in [event-projection-report.json](event-projection-report.json).

**Expected:** The administrator fixture created through Identity registration has exactly one row in User-service's `public.privacy_settings`, initialized by the `user-created` Kafka consumer. No User privacy API was called for this fixture.

**Actual:** Zero rows in 14 read-only polling observations over approximately 9.4 seconds, within a 10-second limit. Docker ownership and the applied UUID schema checks passed.

**Live log corroboration:** User-service reports `ClassNotFoundException: com.kirenz.identity_service.auth.event.UserCreatedEvent` while deserializing `user-created`. This is the producer's Java class name, absent from the consumer service.

**Source:** [AuthService.java](/D:/Kirenz-platform/identity-service/src/main/java/com/kirenz/identity_service/auth/service/AuthService.java:287) publishes the Identity event. [application.yml](/D:/Kirenz-platform/user-service/src/main/resources/application.yml:29) configures Spring Kafka JSON deserialization with trusted packages but no explicit consumer-owned type mapping. [UserEventListener.java](/D:/Kirenz-platform/user-service/src/main/java/com/kirenz/user_service/identity/listener/UserEventListener.java:17) expects its own User-service `UserCreatedEvent` class.

**Impact:** Identity registration does not reliably initialize the User privacy projection. Calling a privacy API can lazily create a row and hide this integration failure; this test deliberately used a fixture untouched by those APIs.

## Passing cross-service checks

The same live run verified A/B authenticated STOMP connections, unauthenticated CONNECT rejection, direct broker private-queue rejection, outsider message-persistence rejection, real two-client topic delivery, private unread summaries, Mongo-backed HTTP history, Identity profile enrichment, HTTP read-receipt queue updates, Redis online presence and offline last-seen transitions.

No LiveKit media connection or external Cloud provider verification was performed by these runners.
