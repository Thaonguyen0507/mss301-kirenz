package com.example.chat_service.call;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import static org.assertj.core.api.Assertions.*;

class LiveKitVideoServiceTest {
    @Test void placeholdersDisableCallingWithoutBreakingChatStartup() {
        var properties = new LiveKitProperties("wss://YOUR_PROJECT.livekit.cloud", "YOUR_API_KEY", "YOUR_API_SECRET",
            Duration.ofMinutes(2), Duration.ofSeconds(60), Duration.ofSeconds(45));
        var video = new LiveKitVideoService(properties);
        assertThatThrownBy(video::requireConfigured).hasMessageContaining("not configured");
        assertThat(properties.toString()).doesNotContain("YOUR_API_SECRET");
    }

    @Test void grantsOnlyCameraMicrophoneAndSubscriptionForAnOpaqueRoomAndIdentity() throws Exception {
        var video = new LiveKitVideoService(new LiveKitProperties("wss://test.livekit.cloud", "api-key", "test-secret",
            Duration.ofMinutes(2), Duration.ofSeconds(60), Duration.ofSeconds(45)));
        var access = video.issueAccess("call-random", "p-random");
        var payload = new ObjectMapper().readTree(Base64.getUrlDecoder().decode(access.participantToken().split("\\.")[1]));
        assertThat(payload.get("sub").asText()).isEqualTo("p-random");
        assertThat(payload.get("exp").asLong() - payload.get("nbf").asLong()).isEqualTo(120);
        assertThat(access.expiresAt()).isBetween(Instant.now().plusSeconds(110), Instant.now().plusSeconds(125));
        var grant = payload.get("video");
        assertThat(grant.get("room").asText()).isEqualTo("call-random");
        assertThat(grant.get("roomJoin").asBoolean()).isTrue();
        assertThat(grant.get("canPublish").asBoolean()).isTrue();
        assertThat(grant.get("canSubscribe").asBoolean()).isTrue();
        assertThat(grant.get("canPublishSources").toString()).isEqualTo("[\"camera\",\"microphone\"]");
        for (String denied : new String[]{"roomAdmin", "roomCreate", "roomList", "roomRecord", "ingressAdmin", "canPublishData", "canUpdateOwnMetadata", "agent"}) {
            assertThat(grant.path(denied).asBoolean()).as(denied).isFalse();
        }
        assertThat(access.toString()).doesNotContain(access.participantToken());
    }
}
