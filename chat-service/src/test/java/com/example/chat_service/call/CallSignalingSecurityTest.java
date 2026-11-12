package com.example.chat_service.call;

import com.example.chat_service.auth.JwtService;
import com.example.chat_service.common.config.WebSocketAuthInterceptor;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.Message;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.MessageBuilder;
import org.springframework.security.access.AccessDeniedException;
import java.security.Principal;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.mock;

class CallSignalingSecurityTest {
    private final WebSocketAuthInterceptor interceptor = new WebSocketAuthInterceptor(mock(JwtService.class));
    private Message<?> frame(StompCommand command, String destination, Principal user) {
        var headers = StompHeaderAccessor.create(command);
        headers.setDestination(destination); headers.setUser(user); headers.setLeaveMutable(true);
        return MessageBuilder.createMessage(new byte[0], headers.getMessageHeaders());
    }
    @Test void deniesAnonymousConnectionsAndSpoofedPrivateQueues() {
        assertThatThrownBy(() -> interceptor.preSend(frame(StompCommand.CONNECT, null, null), null))
            .isInstanceOf(AccessDeniedException.class);
        assertThatThrownBy(() -> interceptor.preSend(frame(StompCommand.SUBSCRIBE, "/user/queue/calls", null), null))
            .isInstanceOf(AccessDeniedException.class);
        for (String destination : new String[]{"/queue/calls-user-other", "/user/other/queue/calls"}) {
            assertThatThrownBy(() -> interceptor.preSend(frame(StompCommand.SUBSCRIBE, destination, () -> "actor"), null))
                .isInstanceOf(AccessDeniedException.class);
        }
        assertThatCode(() -> interceptor.preSend(frame(StompCommand.SUBSCRIBE, "/user/queue/calls", () -> "actor"), null))
            .doesNotThrowAnyException();
    }

    @Test void clientsCannotForgeServerCallEvents() {
        assertThatThrownBy(() -> interceptor.preSend(frame(StompCommand.SEND, "/queue/calls", () -> "actor"), null))
            .isInstanceOf(AccessDeniedException.class);
    }
}
