package com.example.chat_service.call;

import io.livekit.server.*;
import okhttp3.OkHttpClient;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import java.util.concurrent.TimeUnit;

@Service
public class LiveKitVideoService {
    private final LiveKitProperties properties;
    private final RoomServiceClient rooms;

    public LiveKitVideoService(LiveKitProperties properties) {
        this.properties = properties;
        var http = new OkHttpClient.Builder().connectTimeout(1, TimeUnit.SECONDS)
            .readTimeout(3, TimeUnit.SECONDS).callTimeout(4, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false).build();
        rooms = properties.configured() ? RoomServiceClient.createClient(properties.url(),
            properties.apiKey(), properties.apiSecret(), () -> http, false) : null;
    }

    public void requireConfigured() {
        if (rooms == null) throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
            "Video calling is not configured yet. Add the LiveKit credentials to the chat service.");
    }

    public void prepareRoom(String roomName) {
        requireConfigured();
        try {
            var response = rooms.createRoom(roomName, 300, 2).execute();
            if (!response.isSuccessful() || response.body() == null) throw unavailable();
        } catch (IOException exception) { throw unavailable(); }
    }

    public Access issueAccess(String roomName, String identity) {
        requireConfigured();
        var now = Instant.now();
        var expiresAt = now.plus(properties.tokenTtl());
        var token = new AccessToken(properties.apiKey(), properties.apiSecret());
        token.setIdentity(identity);
        token.setNotBefore(Date.from(now));
        token.setExpiration(Date.from(expiresAt));
        token.addGrants(new RoomJoin(true), new RoomName(roomName), new CanPublish(true),
            new CanSubscribe(true), new CanPublishSources(List.of("camera", "microphone")),
            new CanPublishData(false), new CanUpdateOwnMetadata(false), new RoomAdmin(false),
            new RoomCreate(false), new RoomList(false), new RoomRecord(false),
            new IngressAdmin(false), new Agent(false));
        return new Access(properties.url(), token.toJwt(), expiresAt);
    }

    public void endRoom(String roomName, List<String> identities) {
        requireConfigured();
        try {
            // Explicit cutoff also revokes refreshed tokens and participants who already disconnected.
            // Repeat with a fresh cutoff on retries; Cloud revocation lasts ten minutes.
            for (String identity : identities) {
                var response = rooms.removeParticipant(roomName, identity,
                    Instant.now().getEpochSecond() + 2).execute();
                if (!response.isSuccessful()) throw unavailable();
            }
            var response = rooms.deleteRoom(roomName).execute();
            if (!response.isSuccessful() && response.code() != 404) throw unavailable();
        } catch (IOException exception) { throw unavailable(); }
    }

    private ResponseStatusException unavailable() {
        return new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
            "Video calling is temporarily unavailable. Please try again.");
    }

    public record Access(String serverUrl, String participantToken, Instant expiresAt) {
        @Override public String toString() { return "Access[redacted]"; }
    }
}
