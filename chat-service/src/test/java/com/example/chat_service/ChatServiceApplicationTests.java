package com.example.chat_service;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import com.example.chat_service.call.VideoCallRepository;
import com.example.chat_service.conversation.repository.ConversationRepository;
import com.example.chat_service.message.repository.MessageRepository;

@SpringBootTest(properties = {
    "jwt.secret=test-only-signing-key-with-at-least-32-bytes",
    "eureka.client.enabled=false",
    "spring.autoconfigure.exclude=org.springframework.boot.autoconfigure.mongo.MongoAutoConfiguration,org.springframework.boot.autoconfigure.data.mongo.MongoDataAutoConfiguration,org.springframework.boot.autoconfigure.data.mongo.MongoRepositoriesAutoConfiguration"
})
class ChatServiceApplicationTests {
    @MockitoBean VideoCallRepository calls;
    @MockitoBean ConversationRepository conversations;
    @MockitoBean MessageRepository messages;
    @MockitoBean org.springframework.data.mongodb.core.MongoTemplate mongoTemplate;

	@Test
	void contextLoads() {
	}

}
