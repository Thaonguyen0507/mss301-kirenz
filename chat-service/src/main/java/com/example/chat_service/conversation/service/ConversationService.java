package com.example.chat_service.conversation.service;

import com.example.chat_service.common.client.IdentityServiceClient;
import com.example.chat_service.common.dto.ApiResponse;
import com.example.chat_service.common.exception.BadRequestException;
import com.example.chat_service.common.exception.NotFoundException;
import com.example.chat_service.conversation.dto.ConversationResponse;
import com.example.chat_service.conversation.dto.CreateConversationRequest;
import com.example.chat_service.conversation.dto.ParticipantInfo;
import com.example.chat_service.conversation.model.Conversation;
import com.example.chat_service.conversation.model.ConversationType;
import com.example.chat_service.conversation.model.LastMessage;
import com.example.chat_service.conversation.repository.ConversationRepository;
import com.example.chat_service.message.model.DeliveryStatus;
import com.example.chat_service.message.model.Message;
import com.example.chat_service.message.model.MessageStatus;
import com.example.chat_service.message.model.MessageType;
import com.example.chat_service.message.service.MessageBroadcastService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.*;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
@Slf4j
public class ConversationService {

    private final ConversationRepository conversationRepository;
    private final IdentityServiceClient identityServiceClient;
    private final com.example.chat_service.common.client.UserServiceClient userServiceClient;
    private final com.example.chat_service.message.repository.MessageRepository messageRepository;
    private final MessageBroadcastService messageBroadcastService;

    public ConversationResponse createConversation(CreateConversationRequest request, UUID createdBy) {
        if (request.getType() == ConversationType.GROUP && (request.getName() == null || request.getName().isBlank())) {
            throw new BadRequestException("Group name is required for group chat");
        }

        List<UUID> participants = new ArrayList<>(new LinkedHashSet<>(request.getParticipantIds()));
        if (!participants.contains(createdBy)) {
            participants.add(createdBy);
        }
        if (request.getType() == ConversationType.GROUP && participants.size() < 3) {
            throw new BadRequestException("Group chat must have at least 3 participants");
        }

        if (request.getType() == ConversationType.DIRECT) {
            if (participants.size() != 2) {
                throw new BadRequestException("Direct chat must have exactly 2 participants");
            }
            UUID recipientId = participants.stream()
                .filter(id -> !id.equals(createdBy))
                .findFirst()
                .orElseThrow(() -> new BadRequestException("Recipient not found"));
            ensureCanSendDirectMessage(createdBy, recipientId);

            Optional<Conversation> existing = conversationRepository.findExactDirectConversation(
                participants, 2, ConversationType.DIRECT, "ACTIVE");
            if (existing.isPresent()) {
                return convertToResponse(existing.get(), createdBy);
            }
        } else if (request.getType() == ConversationType.GROUP) {
            ensureCanInviteGroupParticipants(createdBy, participants);
        }

        Conversation conversation = Conversation.builder()
            .type(request.getType())
            .name(request.getName())
            .participantIds(participants)
            .adminIds(request.getType() == ConversationType.GROUP ? new ArrayList<>(List.of(createdBy)) : new ArrayList<>())
            .createdBy(createdBy)
            .createdAt(Instant.now())
            .updatedAt(Instant.now())
            .status("ACTIVE")
            .build();

        Conversation saved = conversationRepository.save(conversation);
        return convertToResponse(saved, createdBy);
    }

    public List<ConversationResponse> getUserConversations(UUID userId) {
        return conversationRepository.findByParticipantIdsContainingAndStatusOrderByUpdatedAtDesc(userId, "ACTIVE")
            .stream()
            .map(conv -> convertToResponse(conv, userId))
            .collect(Collectors.toList());
    }

    public ConversationResponse getConversationById(String id, UUID userId) {
        Conversation conversation = requireParticipant(id, userId);
        return convertToResponse(conversation, userId);
    }

    public ConversationResponse updateGroupName(String conversationId, String name, UUID requesterId) {
        Conversation conversation = requireGroupAdmin(conversationId, requesterId);
        if (name == null || name.isBlank()) {
            throw new BadRequestException("Group name is required");
        }
        conversation.setName(name.trim());
        touch(conversation);
        return convertToResponse(conversationRepository.save(conversation), requesterId);
    }

    public void deleteGroup(String conversationId, UUID requesterId) {
        Conversation conversation = requireGroupAdmin(conversationId, requesterId);
        conversation.setStatus("DELETED");
        touch(conversation);
        conversationRepository.save(conversation);
    }

    public ConversationResponse addParticipant(String conversationId, UUID userId, UUID requesterId) {
        Conversation conversation = requireGroupAdmin(conversationId, requesterId);
        if (!conversation.getParticipantIds().contains(userId)) {
            ensureCanInviteGroupParticipant(requesterId, userId);
            conversation.getParticipantIds().add(userId);
            touch(conversation);
            conversationRepository.save(conversation);
        }
        return convertToResponse(conversation, requesterId);
    }

    public ConversationResponse removeParticipant(String conversationId, UUID userId, UUID requesterId) {
        Conversation conversation = requireGroupAdmin(conversationId, requesterId);
        if (userId.equals(requesterId)) {
            throw new BadRequestException("Use leave group instead");
        }
        removeParticipantFromConversation(conversation, userId);
        return convertToResponse(conversationRepository.save(conversation), requesterId);
    }

    public void leaveGroup(String conversationId, UUID requesterId) {
        Conversation conversation = requireParticipant(conversationId, requesterId);
        ensureGroup(conversation);
        String actorName = displayName(conversation, requesterId);
        removeParticipantFromConversation(conversation, requesterId);
        Conversation saved = conversationRepository.save(conversation);
        if (!saved.getParticipantIds().isEmpty()) {
            createAndBroadcastSystemMessage(saved, requesterId, actorName + " has left the group");
        }
    }

    public ConversationResponse makeAdmin(String conversationId, UUID userId, UUID requesterId) {
        Conversation conversation = requireGroupAdmin(conversationId, requesterId);
        if (!conversation.getParticipantIds().contains(userId)) {
            throw new BadRequestException("User is not a participant in this group");
        }
        List<UUID> adminIds = adminIds(conversation);
        if (!adminIds.contains(userId)) {
            adminIds.add(userId);
        }
        conversation.setAdminIds(adminIds);
        touch(conversation);
        return convertToResponse(conversationRepository.save(conversation), requesterId);
    }

    public ConversationResponse updateNickname(String conversationId, UUID targetUserId, String nickname, UUID requesterId) {
        Conversation conversation = requireParticipant(conversationId, requesterId);
        if (!conversation.getParticipantIds().contains(targetUserId)) {
            throw new BadRequestException("User is not a participant in this conversation");
        }
        Map<String, String> nicknames = conversation.getParticipantNicknames() == null
            ? new HashMap<>()
            : new HashMap<>(conversation.getParticipantNicknames());
        String normalized = nickname == null ? "" : nickname.trim();
        if (normalized.isBlank()) {
            nicknames.remove(targetUserId.toString());
        } else {
            nicknames.put(targetUserId.toString(), normalized);
        }
        String systemMessage = nicknameChangeMessage(conversation, requesterId, targetUserId, normalized);
        conversation.setParticipantNicknames(nicknames);
        touch(conversation);
        Conversation saved = conversationRepository.save(conversation);
        createAndBroadcastSystemMessage(saved, requesterId, systemMessage);
        return convertToResponse(saved, requesterId);
    }

    public ConversationResponse getOrCreateDirectConversation(UUID user1Id, UUID user2Id) {
        List<UUID> participants = Arrays.asList(user1Id, user2Id);
        CreateConversationRequest request = CreateConversationRequest.builder()
            .type(ConversationType.DIRECT)
            .participantIds(participants)
            .build();

        return createConversation(request, user1Id);
    }

    public void ensureCanSendDirectMessage(UUID senderId, UUID recipientId) {
        try {
            boolean canMessage = userServiceClient.checkDirectMessagePermission(senderId, recipientId);
            log.info("Direct message permission check for sender {} to receiver {}: {}", senderId, recipientId, canMessage);
            if (!canMessage) {
                throw new AccessDeniedException("This user does not accept messages from people who are not friends.");
            }
        } catch (AccessDeniedException e) {
            throw e;
        } catch (Exception e) {
            log.error("Error checking direct message permission: {}", e.getMessage(), e);
            throw new BadRequestException("Failed to verify direct message permission");
        }
    }

    private void ensureCanInviteGroupParticipants(UUID inviterId, List<UUID> participantIds) {
        for (UUID participantId : participantIds) {
            if (!participantId.equals(inviterId)) {
                ensureCanInviteGroupParticipant(inviterId, participantId);
            }
        }
    }

    private void ensureCanInviteGroupParticipant(UUID inviterId, UUID participantId) {
        try {
            boolean canInvite = userServiceClient.checkDirectMessagePermission(inviterId, participantId);
            log.info("Group invite privacy check for inviter {} to participant {}: {}", inviterId, participantId, canInvite);
            if (!canInvite) {
                throw new AccessDeniedException("This user does not accept group chat invitations from people who are not friends.");
            }
        } catch (AccessDeniedException e) {
            throw e;
        } catch (Exception e) {
            log.error("Error checking group invite privacy permission: {}", e.getMessage(), e);
            throw new BadRequestException("Failed to verify group invite privacy permission");
        }
    }


    public void recordCallSummary(String conversationId, UUID actorId, String content) {
        createAndBroadcastSystemMessage(requireParticipant(conversationId, actorId), actorId, content);
    }

    private void createAndBroadcastSystemMessage(Conversation conversation, UUID actorId, String content) {
        Instant now = Instant.now();
        List<MessageStatus> statusList = conversation.getParticipantIds().stream()
            .map(participantId -> MessageStatus.builder()
                .userId(participantId)
                .status(participantId.equals(actorId) ? DeliveryStatus.READ : DeliveryStatus.SENT)
                .timestamp(now)
                .build())
            .toList();

        Message message = Message.builder()
            .conversationId(conversation.getId())
            .senderId(actorId)
            .content(content)
            .type(MessageType.SYSTEM)
            .sentAt(now)
            .statusList(new ArrayList<>(statusList))
            .status("ACTIVE")
            .build();

        Message savedMessage = messageRepository.save(message);
        conversation.setLastMessage(LastMessage.builder()
            .messageId(savedMessage.getId())
            .content(content)
            .senderId(actorId)
            .senderName("")
            .type(MessageType.SYSTEM)
            .sentAt(savedMessage.getSentAt())
            .build());
        conversation.setUpdatedAt(now);
        Conversation savedConversation = conversationRepository.save(conversation);
        messageBroadcastService.broadcastMessage(savedMessage, savedConversation, "", "");
    }

    private String nicknameChangeMessage(Conversation conversation, UUID requesterId, UUID targetUserId, String nickname) {
        String actorName = displayName(conversation, requesterId);
        String targetName = displayName(conversation, targetUserId);
        if (nickname == null || nickname.isBlank()) {
            return requesterId.equals(targetUserId)
                ? actorName + " cleared their nickname"
                : actorName + " cleared " + targetName + "'s nickname";
        }
        return requesterId.equals(targetUserId)
            ? actorName + " changed their nickname to " + nickname
            : actorName + " changed " + targetName + "'s nickname to " + nickname;
    }

    private String displayName(Conversation conversation, UUID userId) {
        Map<String, String> nicknames = conversation.getParticipantNicknames() == null
            ? Map.of()
            : conversation.getParticipantNicknames();
        String nickname = nicknames.get(userId.toString());
        if (nickname != null && !nickname.isBlank()) {
            return nickname;
        }
        return fetchParticipantInfos(List.of(userId)).stream()
            .findFirst()
            .map(participant -> {
                if (participant.getDisplayName() != null && !participant.getDisplayName().isBlank()) {
                    return participant.getDisplayName();
                }
                if (participant.getUsername() != null && !participant.getUsername().isBlank()) {
                    return participant.getUsername();
                }
                return "Someone";
            })
            .orElse("Someone");
    }

    private Conversation requireParticipant(String conversationId, UUID userId) {
        Conversation conversation = conversationRepository.findById(conversationId)
            .orElseThrow(() -> new NotFoundException("Conversation not found"));
        if (!conversation.getParticipantIds().contains(userId)) {
            throw new BadRequestException("You are not a participant of this conversation");
        }
        if (!"ACTIVE".equals(conversation.getStatus())) {
            throw new NotFoundException("Conversation not found");
        }
        return conversation;
    }

    private Conversation requireGroupAdmin(String conversationId, UUID requesterId) {
        Conversation conversation = requireParticipant(conversationId, requesterId);
        ensureGroup(conversation);
        if (!adminIds(conversation).contains(requesterId)) {
            throw new BadRequestException("Only group admins can perform this action");
        }
        return conversation;
    }

    private void ensureGroup(Conversation conversation) {
        if (conversation.getType() == ConversationType.DIRECT) {
            throw new BadRequestException("This action is only available for group chats");
        }
    }

    private List<UUID> adminIds(Conversation conversation) {
        List<UUID> admins = conversation.getAdminIds() == null ? new ArrayList<>() : new ArrayList<>(conversation.getAdminIds());
        if (admins.isEmpty() && conversation.getCreatedBy() != null && conversation.getParticipantIds().contains(conversation.getCreatedBy())) {
            admins.add(conversation.getCreatedBy());
        }
        return admins;
    }

    private void removeParticipantFromConversation(Conversation conversation, UUID userId) {
        if (!conversation.getParticipantIds().remove(userId)) {
            return;
        }
        List<UUID> admins = adminIds(conversation);
        admins.remove(userId);
        if (admins.isEmpty() && !conversation.getParticipantIds().isEmpty()) {
            admins.add(conversation.getParticipantIds().get(0));
        }
        conversation.setAdminIds(admins);
        if (conversation.getParticipantNicknames() != null) {
            conversation.getParticipantNicknames().remove(userId.toString());
        }
        if (conversation.getParticipantIds().isEmpty()) {
            conversation.setStatus("DELETED");
        }
        touch(conversation);
    }

    private void touch(Conversation conversation) {
        conversation.setUpdatedAt(Instant.now());
    }

    private ConversationResponse convertToResponse(Conversation conversation, UUID currentUserId) {
        List<UUID> adminIds = adminIds(conversation);
        Map<String, String> nicknames = conversation.getParticipantNicknames() == null
            ? Map.of()
            : conversation.getParticipantNicknames();
        List<ParticipantInfo> participants = fetchParticipantInfos(conversation.getParticipantIds()).stream()
            .peek(participant -> {
                UUID participantId = participant.getUserId();
                if (participantId != null) {
                    participant.setNickname(nicknames.get(participantId.toString()));
                    participant.setAdmin(adminIds.contains(participantId));
                }
            })
            .toList();

        return ConversationResponse.builder()
            .id(conversation.getId())
            .type(conversation.getType())
            .name(conversation.getName())
            .participants(participants)
            .adminIds(adminIds)
            .currentUserAdmin(adminIds.contains(currentUserId))
            .lastMessage(conversation.getLastMessage())
            .createdAt(conversation.getCreatedAt())
            .updatedAt(conversation.getUpdatedAt())
            .unreadCount(calculateUnreadCount(conversation.getId(), currentUserId))
            .build();
    }

    private List<ParticipantInfo> fetchParticipantInfos(List<UUID> ids) {
        try {
            ApiResponse<List<ParticipantInfo>> response = identityServiceClient.getProfilesByIds(ids);
            if (response != null && response.isSuccess()) {
                return response.getData();
            }
        } catch (Exception e) {
            log.error("Failed to fetch participant profiles: {}", e.getMessage());
        }
        return ids.stream().map(id -> ParticipantInfo.builder().userId(id).username("Unknown").build()).toList();
    }

    private int calculateUnreadCount(String conversationId, UUID userId) {
        return (int) messageRepository.countUnreadMessages(conversationId, userId);
    }
}
