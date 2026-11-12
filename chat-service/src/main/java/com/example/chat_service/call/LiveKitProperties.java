package com.example.chat_service.call;

import org.springframework.boot.context.properties.ConfigurationProperties;
import java.time.Duration;

@ConfigurationProperties("livekit")
public record LiveKitProperties(String url, String apiKey, String apiSecret, Duration tokenTtl,
                                Duration ringTimeout, Duration disconnectTimeout) {
    public boolean configured() {
        return real(url) && url.startsWith("wss://") && real(apiKey) && real(apiSecret)
            && tokenTtl != null && tokenTtl.compareTo(Duration.ofSeconds(30)) >= 0
            && tokenTtl.compareTo(Duration.ofMinutes(5)) <= 0;
    }

    private boolean real(String value) {
        return value != null && !value.isBlank() && !value.contains("YOUR_");
    }

    @Override public String toString() { return "LiveKitProperties[redacted]"; }
}
