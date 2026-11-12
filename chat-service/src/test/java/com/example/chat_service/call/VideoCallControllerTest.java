package com.example.chat_service.call;

import com.example.chat_service.auth.CurrentUser;
import com.example.chat_service.auth.JwtAuthenticationFilter;
import com.example.chat_service.auth.JwtPrincipal;
import com.example.chat_service.auth.JwtService;
import com.example.chat_service.auth.SecurityConfig;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import java.time.Instant;
import java.util.UUID;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@WebMvcTest(VideoCallController.class)
@Import({SecurityConfig.class, JwtAuthenticationFilter.class, CurrentUser.class})
class VideoCallControllerTest {
    @Autowired MockMvc mvc;
    @MockitoBean VideoCallService calls;
    @MockitoBean JwtService jwt;

    @Test void anonymousUserCannotReadCallsOrGetProviderAccess() throws Exception {
        mvc.perform(get("/api/calls/active")).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/calls/call-1/video-access")).andExpect(status().isUnauthorized());
        verifyNoInteractions(calls);
    }

    @Test void accessUsesAuthenticatedUserAndCannotBeCached() throws Exception {
        UUID actor = UUID.randomUUID();
        when(jwt.parse("session")).thenReturn(new JwtPrincipal(actor, "test@example.invalid", "test", "USER"));
        when(calls.access("call-1", actor)).thenReturn(new LiveKitVideoService.Access(
            "wss://test.livekit.cloud", "participant-token", Instant.now().plusSeconds(120)));
        mvc.perform(post("/api/calls/call-1/video-access").header("Authorization", "Bearer session"))
            .andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"))
            .andExpect(jsonPath("success").value(true))
            .andExpect(jsonPath("data.participantToken").value("participant-token"));
        verify(calls).access("call-1", actor);
    }

    @Test void missingActiveCallKeepsTheStandardEnvelopeWithNullData() throws Exception {
        UUID actor = UUID.randomUUID();
        when(jwt.parse("session")).thenReturn(new JwtPrincipal(actor, "test@example.invalid", "test", "USER"));
        mvc.perform(get("/api/calls/active").header("Authorization", "Bearer session"))
            .andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"))
            .andExpect(jsonPath("success").value(true))
            .andExpect(jsonPath("data").value(org.hamcrest.Matchers.nullValue()));
        verify(calls).active(actor);
    }
}
