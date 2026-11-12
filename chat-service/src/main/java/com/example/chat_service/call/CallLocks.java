package com.example.chat_service.call;

import lombok.RequiredArgsConstructor;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
import java.time.Duration;
import java.util.*;
import java.util.function.Supplier;

@Component
@RequiredArgsConstructor
public class CallLocks {
    private final StringRedisTemplate redis;
    private static final DefaultRedisScript<Long> RELEASE = new DefaultRedisScript<>(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", Long.class);

    // Lock BOTH users in stable order: simultaneous A->B/B->A and A->B/C->B share the same locks.
    // The lease is longer than all bounded provider calls in one operation combined.
    public <T> T withUsers(UUID first, UUID second, Supplier<T> action) {
        List<String> keys = List.of("video-call:lock:" + first, "video-call:lock:" + second)
            .stream().distinct().sorted().toList();
        String owner = UUID.randomUUID().toString();
        List<String> held = new ArrayList<>();
        try {
            for (String key : keys) {
                // Initial Cloud room creation can use the full four-second provider timeout.
                // The peer joining (or hanging up) must also be able to wait for provider cleanup
                // (two removals plus deletion, each bounded to four seconds).
                long deadline = System.nanoTime() + Duration.ofSeconds(15).toNanos();
                while (!Boolean.TRUE.equals(redis.opsForValue().setIfAbsent(key, owner, Duration.ofSeconds(60)))) {
                    if (System.nanoTime() >= deadline) throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "Another call action is in progress. Please try again.");
                    try { Thread.sleep(40); }
                    catch (InterruptedException exception) {
                        Thread.currentThread().interrupt();
                        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Call action interrupted");
                    }
                }
                held.add(key);
            }
            return action.get();
        } finally {
            for (String key : held.reversed()) redis.execute(RELEASE, List.of(key), owner);
        }
    }
}
