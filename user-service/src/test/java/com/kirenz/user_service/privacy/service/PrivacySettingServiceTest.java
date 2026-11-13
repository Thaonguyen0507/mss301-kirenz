package com.kirenz.user_service.privacy.service;

import com.kirenz.user_service.auth.CurrentUser;
import com.kirenz.user_service.block.repository.BlockRepository;
import com.kirenz.user_service.friend.repository.FriendshipRepository;
import com.kirenz.user_service.privacy.model.PrivacySetting;
import com.kirenz.user_service.privacy.repository.PrivacySettingRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class PrivacySettingServiceTest {

    @Mock PrivacySettingRepository privacySettingRepository;
    @Mock FriendshipRepository friendshipRepository;
    @Mock BlockRepository blockRepository;
    @Mock CurrentUser currentUser;
    @InjectMocks PrivacySettingService privacySettingService;

    @Test
    void blocksDirectMessagesFromStrangersWhenReceiverDisablesThem() {
        UUID senderId = UUID.randomUUID();
        UUID receiverId = UUID.randomUUID();
        when(privacySettingRepository.findByUserId(receiverId))
            .thenReturn(Optional.of(PrivacySetting.builder().userId(receiverId).allowDirectMessages(false).build()));
        UUID first = senderId.compareTo(receiverId) < 0 ? senderId : receiverId;
        UUID second = senderId.compareTo(receiverId) < 0 ? receiverId : senderId;
        when(friendshipRepository.existsByUserId1AndUserId2(first, second)).thenReturn(false);

        assertThat(privacySettingService.canSendDirectMessage(senderId, receiverId)).isFalse();
    }

    @Test
    void stillAllowsFriendsWhenReceiverDisablesMessagesFromStrangers() {
        UUID senderId = UUID.randomUUID();
        UUID receiverId = UUID.randomUUID();
        when(privacySettingRepository.findByUserId(receiverId))
            .thenReturn(Optional.of(PrivacySetting.builder().userId(receiverId).allowDirectMessages(false).build()));
        UUID first = senderId.compareTo(receiverId) < 0 ? senderId : receiverId;
        UUID second = senderId.compareTo(receiverId) < 0 ? receiverId : senderId;
        when(friendshipRepository.existsByUserId1AndUserId2(first, second)).thenReturn(true);

        assertThat(privacySettingService.canSendDirectMessage(senderId, receiverId)).isTrue();
    }

    @Test
    void deniesSenderWhoBlockedReceiverEvenWhenReceiverAllowsAnyone() {
        UUID senderId = UUID.randomUUID();
        UUID receiverId = UUID.randomUUID();
        when(blockRepository.existsByBlockerIdAndBlockedId(senderId, receiverId)).thenReturn(true);
        lenient().when(privacySettingRepository.findByUserId(receiverId))
            .thenReturn(Optional.of(PrivacySetting.builder().userId(receiverId).allowDirectMessages(true).build()));

        assertThat(privacySettingService.canSendDirectMessage(senderId, receiverId)).isFalse();
    }

    @Test
    void deniesSenderBlockedByReceiverEvenWhenReceiverAllowsAnyone() {
        UUID senderId = UUID.randomUUID();
        UUID receiverId = UUID.randomUUID();
        when(blockRepository.existsByBlockerIdAndBlockedId(senderId, receiverId)).thenReturn(false);
        when(blockRepository.existsByBlockerIdAndBlockedId(receiverId, senderId)).thenReturn(true);
        lenient().when(privacySettingRepository.findByUserId(receiverId))
            .thenReturn(Optional.of(PrivacySetting.builder().userId(receiverId).allowDirectMessages(true).build()));

        assertThat(privacySettingService.canSendDirectMessage(senderId, receiverId)).isFalse();
    }

    @Test
    void blockTakesPrecedenceOverExistingFriendship() {
        UUID senderId = UUID.randomUUID();
        UUID receiverId = UUID.randomUUID();
        UUID first = senderId.compareTo(receiverId) < 0 ? senderId : receiverId;
        UUID second = senderId.compareTo(receiverId) < 0 ? receiverId : senderId;
        when(blockRepository.existsByBlockerIdAndBlockedId(senderId, receiverId)).thenReturn(false);
        when(blockRepository.existsByBlockerIdAndBlockedId(receiverId, senderId)).thenReturn(true);
        lenient().when(privacySettingRepository.findByUserId(receiverId))
            .thenReturn(Optional.of(PrivacySetting.builder().userId(receiverId).allowDirectMessages(false).build()));
        lenient().when(friendshipRepository.existsByUserId1AndUserId2(first, second)).thenReturn(true);

        assertThat(privacySettingService.canSendDirectMessage(senderId, receiverId)).isFalse();
    }

    @Test
    void deniesBlockedPairWhenReceiverHasNoPrivacySettings() {
        UUID senderId = UUID.randomUUID();
        UUID receiverId = UUID.randomUUID();
        when(blockRepository.existsByBlockerIdAndBlockedId(senderId, receiverId)).thenReturn(true);

        assertThat(privacySettingService.canSendDirectMessage(senderId, receiverId)).isFalse();
    }

    @Test
    void allowsUnblockedStrangersWhenReceiverAllowsAnyone() {
        UUID senderId = UUID.randomUUID();
        UUID receiverId = UUID.randomUUID();
        when(privacySettingRepository.findByUserId(receiverId))
            .thenReturn(Optional.of(PrivacySetting.builder().userId(receiverId).allowDirectMessages(true).build()));

        assertThat(privacySettingService.canSendDirectMessage(senderId, receiverId)).isTrue();
    }

    @Test
    void preservesDefaultPermissionWhenUnblockedReceiverHasNoPrivacySettings() {
        UUID senderId = UUID.randomUUID();
        UUID receiverId = UUID.randomUUID();

        assertThat(privacySettingService.canSendDirectMessage(senderId, receiverId)).isTrue();
    }

    @Test
    void unblockingRestoresReceiverPrivacyPolicy() {
        UUID senderId = UUID.randomUUID();
        UUID receiverId = UUID.randomUUID();
        when(blockRepository.existsByBlockerIdAndBlockedId(senderId, receiverId)).thenReturn(true, false);
        when(blockRepository.existsByBlockerIdAndBlockedId(receiverId, senderId)).thenReturn(false);
        when(privacySettingRepository.findByUserId(receiverId))
            .thenReturn(Optional.of(PrivacySetting.builder().userId(receiverId).allowDirectMessages(true).build()));

        assertThat(privacySettingService.canSendDirectMessage(senderId, receiverId)).isFalse();
        assertThat(privacySettingService.canSendDirectMessage(senderId, receiverId)).isTrue();
    }

    @Test
    void oneSideUnblockingDoesNotOverrideRemainingReverseBlock() {
        UUID senderId = UUID.randomUUID();
        UUID receiverId = UUID.randomUUID();
        when(blockRepository.existsByBlockerIdAndBlockedId(senderId, receiverId)).thenReturn(true, false);
        when(blockRepository.existsByBlockerIdAndBlockedId(receiverId, senderId)).thenReturn(true);

        assertThat(privacySettingService.canSendDirectMessage(senderId, receiverId)).isFalse();
        assertThat(privacySettingService.canSendDirectMessage(senderId, receiverId)).isFalse();
    }
}
