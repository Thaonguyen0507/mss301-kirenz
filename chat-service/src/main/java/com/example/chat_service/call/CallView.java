package com.example.chat_service.call;

import java.time.Instant;
import java.util.UUID;

// Deliberately excludes provider room names, identities, credentials and access tokens.
public record CallView(String id, String conversationId, Peer caller, Peer callee,
                       VideoCall.Status status, VideoCall.EndReason endReason, Instant createdAt,
                       Instant ringingExpiresAt, Instant acceptedAt, Instant endedAt,
                       boolean mediaClosed, long revision) {
    public record Peer(UUID userId, String displayName, String avatarUrl) { }
    public static CallView of(VideoCall call) {
        return new CallView(call.getId(), call.getConversationId(), call.getCaller(), call.getCallee(),
            call.getStatus(), call.getEndReason(), call.getCreatedAt(), call.getRingingExpiresAt(),
            call.getAcceptedAt(), call.getEndedAt(), call.getStatus() == VideoCall.Status.ENDED && !call.isCleanupPending(), call.getRevision());
    }
}
