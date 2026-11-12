package com.example.chat_service.call;

import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.data.mongodb.repository.Query;
import java.util.List;
import java.util.UUID;

public interface VideoCallRepository extends MongoRepository<VideoCall, String> {
    @Query("{'$or': [{'callerId': ?0}, {'calleeId': ?0}], 'status': {'$in': ['RINGING', 'ACCEPTED']}}")
    List<VideoCall> findActiveForUser(UUID userId);

    @Query("{'$or': [{'status': {'$in': ['RINGING', 'ACCEPTED']}}, {'cleanupPending': true}]}")
    List<VideoCall> findForMaintenance();
}
