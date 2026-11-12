package com.example.chat_service.call;

import com.example.chat_service.auth.CurrentUser;
import com.example.chat_service.common.dto.ApiResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/calls")
@RequiredArgsConstructor
public class VideoCallController {
    private final VideoCallService calls;
    private final CurrentUser user;
    public record StartRequest(@NotBlank String conversationId) { }

    @PostMapping
    public ResponseEntity<ApiResponse<CallView>> start(@Valid @RequestBody StartRequest request) {
        return noStore("Call started", calls.start(request.conversationId(), user.id()));
    }

    @GetMapping("/active")
    public ResponseEntity<ApiResponse<CallView>> active() {
        return noStore("Active call retrieved", calls.active(user.id()));
    }

    @GetMapping("/{id}")
    public ResponseEntity<ApiResponse<CallView>> get(@PathVariable String id) {
        return noStore("Call retrieved", calls.get(id, user.id()));
    }

    @PostMapping("/{id}/accept")
    public ResponseEntity<ApiResponse<CallView>> accept(@PathVariable String id) {
        return noStore("Call accepted", calls.accept(id, user.id()));
    }

    @PostMapping("/{id}/decline")
    public ResponseEntity<ApiResponse<CallView>> decline(@PathVariable String id) {
        return noStore("Call declined", calls.decline(id, user.id()));
    }

    @PostMapping("/{id}/end")
    public ResponseEntity<ApiResponse<CallView>> end(@PathVariable String id) {
        return noStore("Call ended", calls.end(id, user.id()));
    }

    @PostMapping("/{id}/heartbeat")
    public ResponseEntity<ApiResponse<CallView>> heartbeat(@PathVariable String id) {
        return noStore("Call presence updated", calls.heartbeat(id, user.id()));
    }

    @PostMapping("/{id}/video-access")
    public ResponseEntity<ApiResponse<LiveKitVideoService.Access>> access(@PathVariable String id) {
        return noStore("Video access granted", calls.access(id, user.id()));
    }

    private <T> ResponseEntity<ApiResponse<T>> noStore(String message, T data) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(ApiResponse.success(message, data));
    }
}
