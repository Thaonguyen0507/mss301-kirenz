package com.kirenz.user_service.privacy.service;

import com.kirenz.user_service.auth.CurrentUser;
import com.kirenz.user_service.block.repository.BlockRepository;
import com.kirenz.user_service.privacy.dto.PrivacySettingResponse;
import com.kirenz.user_service.privacy.dto.UpdatePrivacySettingRequest;
import com.kirenz.user_service.privacy.model.PrivacySetting;
import com.kirenz.user_service.privacy.model.Visibility;
import com.kirenz.user_service.privacy.repository.PrivacySettingRepository;
import com.kirenz.user_service.friend.repository.FriendshipRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

@Service
@RequiredArgsConstructor
@Slf4j
public class PrivacySettingService {

    private final PrivacySettingRepository privacySettingRepository;
    private final FriendshipRepository friendshipRepository;
    private final BlockRepository blockRepository;
    private final CurrentUser currentUser;

    @Transactional(readOnly = true)
    public PrivacySettingResponse getPrivacySettings() {
        UUID userId = currentUser.id();
        return toResponse(getOrCreateSettings(userId));
    }

    @Transactional(readOnly = true)
    public PrivacySettingResponse getPrivacySettingsByUserId(UUID userId) {
        return toResponse(getOrCreateSettings(userId));
    }

    @Transactional
    public PrivacySettingResponse updatePrivacySettings(UpdatePrivacySettingRequest request) {
        UUID userId = currentUser.id();
        PrivacySetting settings = getOrCreateSettings(userId);

        if (request.getProfileVisibility() != null) {
            settings.setProfileVisibility(request.getProfileVisibility());
        }
        if (request.getPostVisibility() != null) {
            settings.setPostVisibility(request.getPostVisibility());
        }
        if (request.getAllowDirectMessages() != null) {
            settings.setAllowDirectMessages(request.getAllowDirectMessages());
        }
        if (request.getShowOnlineStatus() != null) {
            settings.setShowOnlineStatus(request.getShowOnlineStatus());
        }

        return toResponse(privacySettingRepository.save(settings));
    }

    @Transactional(readOnly = true)
    public boolean canSendDirectMessage(UUID senderId, UUID receiverId) {
        if (blockRepository.existsByBlockerIdAndBlockedId(senderId, receiverId)
            || blockRepository.existsByBlockerIdAndBlockedId(receiverId, senderId)) {
            return false;
        }

        boolean allowsAnyone = privacySettingRepository.findByUserId(receiverId)
            .map(PrivacySetting::getAllowDirectMessages)
            .orElse(true); // Default to true for existing users without settings
        if (allowsAnyone) {
            return true;
        }

        UUID first = senderId.compareTo(receiverId) < 0 ? senderId : receiverId;
        UUID second = senderId.compareTo(receiverId) < 0 ? receiverId : senderId;
        return friendshipRepository.existsByUserId1AndUserId2(first, second);
    }

    @Transactional(readOnly = true)
    public boolean canCurrentUserSendDirectMessage(UUID receiverId) {
        return canSendDirectMessage(currentUser.id(), receiverId);
    }

    @Transactional
    public void initializeDefaultSettings(UUID userId) {
        if (privacySettingRepository.findByUserId(userId).isEmpty()) {
            PrivacySetting settings = PrivacySetting.builder()
                .userId(userId)
                .profileVisibility(Visibility.PUBLIC)
                .postVisibility(Visibility.PUBLIC)
                .allowDirectMessages(true)
                .showOnlineStatus(true)
                .build();
            privacySettingRepository.save(settings);
            log.info("Initialized default privacy settings for user: {}", userId);
        }
    }

    private PrivacySetting getOrCreateSettings(UUID userId) {
        return privacySettingRepository.findByUserId(userId)
            .orElseGet(() -> {
                PrivacySetting settings = PrivacySetting.builder()
                    .userId(userId)
                    .profileVisibility(Visibility.PUBLIC)
                    .postVisibility(Visibility.PUBLIC)
                    .allowDirectMessages(true)
                    .showOnlineStatus(true)
                    .build();
                return privacySettingRepository.save(settings);
            });
    }

    private PrivacySettingResponse toResponse(PrivacySetting settings) {
        return PrivacySettingResponse.builder()
            .userId(settings.getUserId())
            .profileVisibility(settings.getProfileVisibility())
            .postVisibility(settings.getPostVisibility())
            .allowDirectMessages(settings.getAllowDirectMessages())
            .showOnlineStatus(settings.getShowOnlineStatus())
            .updatedAt(settings.getUpdatedAt())
            .build();
    }
}
