package com.example.chat_service.call;

import com.example.chat_service.conversation.dto.ParticipantInfo;
import com.example.chat_service.conversation.model.Conversation;
import com.example.chat_service.conversation.model.ConversationType;
import com.example.chat_service.conversation.repository.ConversationRepository;
import com.example.chat_service.conversation.service.ConversationService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.function.Function;

import static com.example.chat_service.call.VideoCall.Status.*;
import static com.example.chat_service.call.VideoCall.EndReason.CANCELLED;
import static com.example.chat_service.call.VideoCall.EndReason.DECLINED;
import static com.example.chat_service.call.VideoCall.EndReason.MISSED;
import static com.example.chat_service.call.VideoCall.EndReason.DISCONNECTED;

@Service
@RequiredArgsConstructor
@Slf4j
public class VideoCallService {
    private final VideoCallRepository calls;
    private final ConversationRepository conversations;
    private final ConversationService conversationService;
    private final LiveKitVideoService video;
    private final CallLocks locks;
    private final SimpMessagingTemplate messages;
    private final LiveKitProperties properties;

    public CallView start(String conversationId, UUID actor) {
        Conversation conversation = requireDirectConversation(conversationId, actor);
        UUID other = conversation.getParticipantIds().stream().filter(id -> !id.equals(actor)).findFirst().orElseThrow();
        conversationService.ensureCanSendDirectMessage(actor, other);
        video.requireConfigured();
        // Fetch display info outside the state lock; never trust participant details supplied by clients.
        var participants = conversationService.getConversationById(conversationId, actor).getParticipants();
        return locks.withUsers(actor, other, () -> {
            List<VideoCall> active = calls.findActiveForUser(actor);
            if (!active.isEmpty()) {
                VideoCall existing = active.getFirst();
                if (existing.getConversationId().equals(conversationId)) {
                    expire(existing);
                    if (existing.getStatus() != ENDED) {
                        // Both users clicking Call is an explicit acceptance of the existing invitation.
                        if (existing.getStatus() == RINGING && actor.equals(existing.getCalleeId())) acceptCall(existing);
                        return CallView.of(existing);
                    }
                } else throw conflict("You are already in another call");
            }
            if (!calls.findActiveForUser(other).isEmpty()) throw conflict("This person is already in another call");
            Instant now = Instant.now();
            VideoCall call = VideoCall.builder().id(UUID.randomUUID().toString()).conversationId(conversationId)
                .callerId(actor).calleeId(other).caller(peer(actor, participants)).callee(peer(other, participants))
                .roomName("call-" + UUID.randomUUID()).callerIdentity("p-" + UUID.randomUUID())
                .calleeIdentity("p-" + UUID.randomUUID()).status(RINGING).createdAt(now)
                .ringingExpiresAt(now.plus(properties.ringTimeout())).revision(1).build();
            calls.save(call);
            broadcast(call);
            return CallView.of(call);
        });
    }

    public CallView active(UUID actor) {
        return calls.findActiveForUser(actor).stream().findFirst()
            .map(call -> withCall(call.getId(), actor, current -> { expire(current); return CallView.of(current); }))
            .orElse(null);
    }

    public CallView get(String id, UUID actor) {
        return withCall(id, actor, call -> { expire(call); return CallView.of(call); });
    }

    public CallView accept(String id, UUID actor) {
        return withCall(id, actor, call -> {
            if (!actor.equals(call.getCalleeId())) throw forbidden();
            expire(call);
            if (call.getStatus() == ENDED) throw conflict("This call has already ended");
            if (call.getStatus() == RINGING) {
                requireDirectConversation(call.getConversationId(), actor);
                conversationService.ensureCanSendDirectMessage(call.getCallerId(), call.getCalleeId());
                acceptCall(call);
            }
            return CallView.of(call);
        });
    }

    public CallView decline(String id, UUID actor) {
        return withCall(id, actor, call -> {
            if (!actor.equals(call.getCalleeId())) throw forbidden();
            if (call.getStatus() == ACCEPTED) throw conflict("This call has already been accepted");
            if (call.getStatus() == RINGING) finish(call, DECLINED);
            return CallView.of(call);
        });
    }

    public CallView end(String id, UUID actor) {
        return withCall(id, actor, call -> {
            if (call.getStatus() != ENDED) finish(call, call.getStatus() == RINGING ? CANCELLED : VideoCall.EndReason.ENDED);
            else cleanup(call);
            return CallView.of(call);
        });
    }

    public CallView heartbeat(String id, UUID actor) {
        return withCall(id, actor, call -> {
            expire(call);
            if (call.getStatus() == ACCEPTED) {
                if (actor.equals(call.getCallerId())) call.setCallerSeenAt(Instant.now());
                else call.setCalleeSeenAt(Instant.now());
                calls.save(call);
            }
            return CallView.of(call);
        });
    }

    public LiveKitVideoService.Access access(String id, UUID actor) {
        return withCall(id, actor, call -> {
            expire(call);
            if (call.getStatus() != ACCEPTED) throw conflict("The call must be accepted and active before joining");
            requireDirectConversation(call.getConversationId(), actor);
            // Mark before the network request: a timeout can mean the room was created remotely.
            call.setRoomCreated(true);
            calls.save(call);
            video.prepareRoom(call.getRoomName());
            // Access and end use the same participant locks, including while waiting for LiveKit.
            // An expired ringing invitation or terminated call can never mint fresh access.
            return video.issueAccess(call.getRoomName(), actor.equals(call.getCallerId())
                ? call.getCallerIdentity() : call.getCalleeIdentity());
        });
    }

    private void acceptCall(VideoCall call) {
        Instant now = Instant.now();
        call.setStatus(ACCEPTED);
        call.setAcceptedAt(now);
        call.setCallerSeenAt(now);
        call.setCalleeSeenAt(now);
        saveAndBroadcast(call);
    }

    private void expire(VideoCall call) {
        Instant now = Instant.now();
        if (call.getStatus() == RINGING && !call.getRingingExpiresAt().isAfter(now)) finish(call, MISSED);
        if (call.getStatus() == ACCEPTED &&
            (call.getCallerSeenAt().plus(properties.disconnectTimeout()).isBefore(now)
            || call.getCalleeSeenAt().plus(properties.disconnectTimeout()).isBefore(now))) finish(call, DISCONNECTED);
    }

    private void finish(VideoCall call, VideoCall.EndReason reason) {
        call.setStatus(ENDED);
        call.setEndReason(reason);
        call.setEndedAt(Instant.now());
        call.setCleanupPending(call.isRoomCreated());
        // Persist termination and notify both clients before attempting provider cleanup.
        saveAndBroadcast(call);
        try {
            String summary = switch (reason) {
                case MISSED -> "Missed video call";
                case DECLINED -> "Video call declined";
                case CANCELLED -> "Video call cancelled";
                default -> {
                    long seconds = call.getAcceptedAt() == null ? 0 : Duration.between(call.getAcceptedAt(), call.getEndedAt()).toSeconds();
                    yield "Video call ended · %02d:%02d".formatted(seconds / 60, seconds % 60);
                }
            };
            conversationService.recordCallSummary(call.getConversationId(), call.getCallerId(), summary);
        } catch (RuntimeException exception) { log.warn("Could not record call summary for {}", call.getId()); }
        cleanup(call);
    }

    private void cleanup(VideoCall call) {
        if (!call.isCleanupPending()) return;
        try {
            video.endRoom(call.getRoomName(), List.of(call.getCallerIdentity(), call.getCalleeIdentity()));
            call.setCleanupPending(false);
            saveAndBroadcast(call);
        } catch (RuntimeException exception) {
            // State stays ENDED, fresh tokens stay blocked, and maintenance retries after provider recovery.
            log.warn("LiveKit cleanup pending for call {}; retrying on next maintenance pass", call.getId());
        }
    }

    @Scheduled(fixedDelay = 5000)
    public void maintainCalls() {
        try {
            for (VideoCall snapshot : calls.findForMaintenance()) {
                try {
                    locks.withUsers(snapshot.getCallerId(), snapshot.getCalleeId(), () -> {
                        calls.findById(snapshot.getId()).ifPresent(call -> { expire(call); cleanup(call); });
                        return null;
                    });
                } catch (RuntimeException exception) { log.warn("Call maintenance deferred for {}", snapshot.getId()); }
            }
        } catch (RuntimeException exception) { log.warn("Call maintenance unavailable; will retry"); }
    }

    private <T> T withCall(String id, UUID actor, Function<VideoCall, T> action) {
        VideoCall snapshot = requireMember(id, actor);
        return locks.withUsers(snapshot.getCallerId(), snapshot.getCalleeId(), () -> action.apply(requireMember(id, actor)));
    }

    private VideoCall requireMember(String id, UUID actor) {
        VideoCall call = calls.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Call not found"));
        if (!actor.equals(call.getCallerId()) && !actor.equals(call.getCalleeId())) throw forbidden();
        return call;
    }

    private Conversation requireDirectConversation(String id, UUID actor) {
        Conversation conversation = conversations.findById(id)
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Conversation not found"));
        if (!conversation.getParticipantIds().contains(actor)) throw forbidden();
        if (!"ACTIVE".equals(conversation.getStatus()) || conversation.getType() != ConversationType.DIRECT
            || conversation.getParticipantIds().stream().distinct().count() != 2)
            throw conflict("Video calls are only available in active one-to-one conversations");
        return conversation;
    }

    private CallView.Peer peer(UUID id, List<ParticipantInfo> participants) {
        return participants.stream().filter(participant -> id.equals(participant.getUserId())).findFirst()
            .map(participant -> new CallView.Peer(id,
                participant.getNickname() != null && !participant.getNickname().isBlank() ? participant.getNickname()
                    : participant.getDisplayName() != null ? participant.getDisplayName() : participant.getUsername(),
                participant.getAvatarUrl()))
            .orElse(new CallView.Peer(id, "Kirenz user", null));
    }

    private void saveAndBroadcast(VideoCall call) {
        call.setRevision(call.getRevision() + 1);
        calls.save(call);
        broadcast(call);
    }

    private void broadcast(VideoCall call) {
        for (UUID user : List.of(call.getCallerId(), call.getCalleeId())) {
            messages.convertAndSendToUser(user.toString(), "/queue/calls", CallView.of(call));
        }
    }

    private ResponseStatusException forbidden() { return new ResponseStatusException(HttpStatus.FORBIDDEN, "You are not allowed to perform this call action"); }
    private ResponseStatusException conflict(String message) { return new ResponseStatusException(HttpStatus.CONFLICT, message); }
}
