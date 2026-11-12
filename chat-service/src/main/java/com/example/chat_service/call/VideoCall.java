package com.example.chat_service.call;

import lombok.*;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import java.time.Instant;
import java.util.UUID;

@Document("video_calls")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class VideoCall {
    public enum Status { RINGING, ACCEPTED, ENDED }
    public enum EndReason { ENDED, CANCELLED, DECLINED, MISSED, DISCONNECTED }
    @Id private String id;
    private String conversationId;
    private UUID callerId;
    private UUID calleeId;
    private CallView.Peer caller;
    private CallView.Peer callee;
    private String roomName;
    private String callerIdentity;
    private String calleeIdentity;
    private Status status;
    private EndReason endReason;
    private Instant createdAt;
    private Instant ringingExpiresAt;
    private Instant acceptedAt;
    private Instant endedAt;
    private Instant callerSeenAt;
    private Instant calleeSeenAt;
    private boolean roomCreated;
    private boolean cleanupPending;
    private long revision;
}
