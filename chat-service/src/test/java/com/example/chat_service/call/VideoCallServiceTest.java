package com.example.chat_service.call;

import com.example.chat_service.conversation.dto.ConversationResponse;
import com.example.chat_service.conversation.model.Conversation;
import com.example.chat_service.conversation.model.ConversationType;
import com.example.chat_service.conversation.repository.ConversationRepository;
import com.example.chat_service.conversation.service.ConversationService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class VideoCallServiceTest {
    private final UUID a = UUID.randomUUID(), b = UUID.randomUUID(), outsider = UUID.randomUUID();
    private final VideoCallRepository calls = mock(VideoCallRepository.class);
    private final ConversationRepository conversations = mock(ConversationRepository.class);
    private final ConversationService conversationService = mock(ConversationService.class);
    private final LiveKitVideoService video = mock(LiveKitVideoService.class);
    private final SimpMessagingTemplate messages = mock(SimpMessagingTemplate.class);
    private final Map<String, VideoCall> stored = new ConcurrentHashMap<>();
    private VideoCallService service;
    private Conversation direct;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setup() {
        // Exercise the actual participant-lock implementation with a thread-safe Redis double.
        var redis = mock(StringRedisTemplate.class);
        ValueOperations<String, String> values = mock(ValueOperations.class);
        Map<String, String> leases = new ConcurrentHashMap<>();
        when(redis.opsForValue()).thenReturn(values);
        when(values.setIfAbsent(anyString(), anyString(), any(Duration.class)))
            .thenAnswer(invocation -> leases.putIfAbsent(invocation.getArgument(0), invocation.getArgument(1)) == null);
        when(redis.execute(any(RedisScript.class), anyList(), any(Object[].class)))
            .thenAnswer(invocation -> { List<String> keys = invocation.getArgument(1); leases.remove(keys.getFirst(), invocation.getArgument(2)); return 1L; });
        service = new VideoCallService(calls, conversations, conversationService, video, new CallLocks(redis), messages,
            new LiveKitProperties("wss://test.livekit.cloud", "key", "secret", Duration.ofMinutes(2), Duration.ofSeconds(60), Duration.ofSeconds(45)));
        direct = Conversation.builder().id("direct").type(ConversationType.DIRECT).participantIds(List.of(a, b)).build();
        when(conversations.findById("direct")).thenReturn(Optional.of(direct));
        when(conversationService.getConversationById(eq("direct"), any()))
            .thenReturn(ConversationResponse.builder().participants(List.of()).build());
        when(calls.save(any())).thenAnswer(invocation -> {
            VideoCall call = invocation.getArgument(0); stored.put(call.getId(), call); return call;
        });
        when(calls.findById(anyString())).thenAnswer(invocation -> Optional.ofNullable(stored.get(invocation.getArgument(0))));
        when(calls.findActiveForUser(any())).thenAnswer(invocation -> stored.values().stream()
            .filter(call -> call.getStatus() != VideoCall.Status.ENDED)
            .filter(call -> invocation.getArgument(0).equals(call.getCallerId()) || invocation.getArgument(0).equals(call.getCalleeId())).toList());
        when(calls.findForMaintenance()).thenAnswer(invocation -> stored.values().stream()
            .filter(call -> call.getStatus() != VideoCall.Status.ENDED || call.isCleanupPending()).toList());
    }

    @Test void crossingInvitationsConvergeOnOneAcceptedCallUnderConcurrency() throws Exception {
        var executor = Executors.newFixedThreadPool(2);
        var start = new CountDownLatch(1);
        try {
            var first = executor.submit(() -> { start.await(); return service.start("direct", a); });
            var second = executor.submit(() -> { start.await(); return service.start("direct", b); });
            start.countDown();
            var resultA = first.get(5, TimeUnit.SECONDS);
            var resultB = second.get(5, TimeUnit.SECONDS);
            assertThat(resultA.id()).isEqualTo(resultB.id());
            assertThat(stored).hasSize(1);
            VideoCall call = stored.values().iterator().next();
            assertThat(call.getStatus()).isEqualTo(VideoCall.Status.ACCEPTED);
            assertThat(call.getCallerIdentity()).isNotEqualTo(call.getCalleeIdentity());
            assertThat(call.getRoomName()).startsWith("call-").doesNotContain(a.toString(), b.toString());
        } finally { executor.shutdownNow(); }
    }

    @Test void duplicateCallerClickDoesNotAcceptOrCreateAnotherRoom() {
        var first = service.start("direct", a);
        var second = service.start("direct", a);
        assertThat(first.id()).isEqualTo(second.id());
        assertThat(second.status()).isEqualTo(VideoCall.Status.RINGING);
        assertThat(stored).hasSize(1);
        verify(video, never()).prepareRoom(anyString());
    }

    @Test void bothParticipantsCanAcquireAccessWhileInitialCloudRoomCreationTakesOverThreeSeconds() throws Exception {
        var call = service.start("direct", a);
        service.accept(call.id(), b);
        var enteredProvider = new CountDownLatch(1);
        doAnswer(invocation -> {
            enteredProvider.countDown();
            Thread.sleep(3200);
            return null;
        }).doNothing().when(video).prepareRoom(anyString());
        var executor = Executors.newFixedThreadPool(2);
        try {
            var caller = executor.submit(() -> service.access(call.id(), a));
            assertThat(enteredProvider.await(2, TimeUnit.SECONDS)).isTrue();
            var callee = executor.submit(() -> service.access(call.id(), b));
            caller.get(8, TimeUnit.SECONDS);
            callee.get(8, TimeUnit.SECONDS);
            var saved = stored.get(call.id());
            verify(video).issueAccess(saved.getRoomName(), saved.getCallerIdentity());
            verify(video).issueAccess(saved.getRoomName(), saved.getCalleeIdentity());
        } finally { executor.shutdownNow(); }
    }

    @Test void rejectsGroupCallsAndOutsidersBeforeIssuingAccess() {
        direct.setType(ConversationType.GROUP);
        assertThatThrownBy(() -> service.start("direct", a)).isInstanceOf(ResponseStatusException.class);
        direct.setType(ConversationType.DIRECT);
        var call = service.start("direct", a);
        for (Supplier<?> action : List.<Supplier<?>>of(() -> service.access(call.id(), outsider),
                () -> service.end(call.id(), outsider), () -> service.get(call.id(), outsider))) {
            assertThatThrownBy(action::get).isInstanceOfSatisfying(ResponseStatusException.class,
                exception -> assertThat(exception.getStatusCode().value()).isEqualTo(403));
        }
        verify(video, never()).issueAccess(anyString(), anyString());
    }

    @Test void onlyCalleeAcceptsAndAccessRequiresAcceptance() {
        var call = service.start("direct", a);
        assertThatThrownBy(() -> service.accept(call.id(), a)).isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(() -> service.access(call.id(), b)).isInstanceOf(ResponseStatusException.class);
        service.accept(call.id(), b);
        service.access(call.id(), a);
        service.access(call.id(), b);
        var saved = stored.get(call.id());
        verify(video).issueAccess(saved.getRoomName(), saved.getCallerIdentity());
        verify(video).issueAccess(saved.getRoomName(), saved.getCalleeIdentity());
        verify(messages, atLeastOnce()).convertAndSendToUser(eq(a.toString()), eq("/queue/calls"), any(CallView.class));
        verify(messages, atLeastOnce()).convertAndSendToUser(eq(b.toString()), eq("/queue/calls"), any(CallView.class));
    }

    @Test void ringingExpiresAndLateAcceptanceCannotReviveIt() {
        var call = service.start("direct", a);
        stored.get(call.id()).setRingingExpiresAt(Instant.now().minusSeconds(1));
        service.maintainCalls();
        assertThat(service.get(call.id(), a).endReason()).isEqualTo(VideoCall.EndReason.MISSED);
        assertThatThrownBy(() -> service.accept(call.id(), b)).isInstanceOf(ResponseStatusException.class);
        verify(conversationService).recordCallSummary("direct", a, "Missed video call");
    }

    @Test void hangupEndsBothAndPreventsAllNewTokensEvenWhenCleanupFails() {
        var call = service.start("direct", a);
        service.accept(call.id(), b);
        service.access(call.id(), a);
        doThrow(new IllegalStateException("provider offline")).when(video).endRoom(anyString(), anyList());
        var ended = service.end(call.id(), b);
        assertThat(ended.status()).isEqualTo(VideoCall.Status.ENDED);
        assertThat(ended.mediaClosed()).isFalse();
        assertThatThrownBy(() -> service.access(call.id(), a)).isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(() -> service.access(call.id(), b)).isInstanceOf(ResponseStatusException.class);
        doNothing().when(video).endRoom(anyString(), anyList());
        service.maintainCalls();
        assertThat(service.get(call.id(), a).mediaClosed()).isTrue();
        assertThat(service.active(a)).isNull();
        assertThat(service.active(b)).isNull();
        service.end(call.id(), a); // idempotent hangup
        verify(conversationService, times(1)).recordCallSummary(eq("direct"), eq(a), startsWith("Video call ended"));
    }

    @Test void cancelAndDeclineEndRingingWithoutContactingProvider() {
        var first = service.start("direct", a);
        assertThat(service.end(first.id(), a).endReason()).isEqualTo(VideoCall.EndReason.CANCELLED);
        var second = service.start("direct", a);
        assertThat(second.id()).isNotEqualTo(first.id());
        assertThat(service.decline(second.id(), b).endReason()).isEqualTo(VideoCall.EndReason.DECLINED);
        verify(video, never()).endRoom(anyString(), anyList());
    }

    @Test void blocksOverlappingCallsToBusyUser() {
        service.start("direct", a);
        when(conversations.findById("other")).thenReturn(Optional.of(Conversation.builder().id("other")
            .type(ConversationType.DIRECT).participantIds(List.of(outsider, b)).build()));
        when(conversationService.getConversationById(eq("other"), any()))
            .thenReturn(ConversationResponse.builder().participants(List.of()).build());
        assertThatThrownBy(() -> service.start("other", outsider)).isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("already in another call");
        assertThat(stored).hasSize(1);
    }

    @Test void missingHeartbeatTerminatesAbandonedCall() {
        var call = service.start("direct", a);
        service.accept(call.id(), b);
        stored.get(call.id()).setCalleeSeenAt(Instant.now().minusSeconds(46));
        service.maintainCalls();
        assertThat(service.get(call.id(), a).endReason()).isEqualTo(VideoCall.EndReason.DISCONNECTED);
    }
}
