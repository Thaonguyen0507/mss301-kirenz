package com.example.chat_service.common.config;

import com.example.chat_service.auth.JwtPrincipal;
import com.example.chat_service.auth.JwtService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.stereotype.Component;

import java.util.List;

@Component
@RequiredArgsConstructor
@Slf4j
public class WebSocketAuthInterceptor implements ChannelInterceptor {

    private final JwtService jwtService;

    @Override
    public Message<?> preSend(Message<?> message, MessageChannel channel) {
        StompHeaderAccessor accessor = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);

        if (accessor != null && StompCommand.CONNECT.equals(accessor.getCommand())) {
            String authHeader = accessor.getFirstNativeHeader("Authorization");

            if (authHeader != null && authHeader.startsWith("Bearer ")) {
                String token = authHeader.substring(7);
                try {
                    JwtPrincipal principal = jwtService.parse(token);
                    var authentication = new UsernamePasswordAuthenticationToken(
                        principal,
                        null,
                        List.of(new SimpleGrantedAuthority("ROLE_" + principal.role()))
                    ) {
                        @Override
                        public String getName() {
                            return principal.userId().toString();
                        }
                    };
                    accessor.setUser(authentication);
                    log.info("WebSocket connection authenticated for user: {}", principal.username());
                } catch (Exception e) {
                    throw new org.springframework.security.access.AccessDeniedException("WebSocket authentication required");
                }
            } else throw new org.springframework.security.access.AccessDeniedException("WebSocket authentication required");
        }
        if (accessor != null && (StompCommand.SUBSCRIBE.equals(accessor.getCommand())
                || StompCommand.SEND.equals(accessor.getCommand()))) {
            if (accessor.getUser() == null) throw new org.springframework.security.access.AccessDeniedException("Authentication required");
            String destination = accessor.getDestination();
            // Physical broker queues may include another session's suffix. Only subscribe via /user/queue.
            if (StompCommand.SUBSCRIBE.equals(accessor.getCommand()) && destination != null
                && (destination.startsWith("/queue/") || destination.startsWith("/user/")
                    && !List.of("/user/queue/messages", "/user/queue/calls").contains(destination))) {
                throw new org.springframework.security.access.AccessDeniedException("Private queue access denied");
            }
            if (StompCommand.SEND.equals(accessor.getCommand()) && destination != null
                && !destination.startsWith("/app/")) {
                throw new org.springframework.security.access.AccessDeniedException("Broker destinations are server-only");
            }
        }
        return message;
    }
}
