import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Search, Bell, Menu, Video, Info,
  MessageSquare, PlusCircle, Smile, Send, X, Edit3, Loader2,
  Users, UserPlus, Check, Image as ImageIcon, Download, FileText, Shield, UserMinus, LogOut, Trash2
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import Layout from './components/Layout';
import { useAuthStore } from './store/authStore';
import { useVideoCall } from './components/calls/VideoCallProvider';
import { useChat, useConversationMessages } from './hooks/useChat';
import { Attachment, Conversation, MessageType, PendingChatMedia } from './types/chat';
import { ConfirmDialog } from './components/common/ConfirmDialog';
import { UserSearchResponse } from './types/friend.types';
import { useEscapeKey } from './hooks/useEscapeKey';
import { chatService } from './services/chat.service';
import { blockService } from './services/block.service';
import { privacyService } from './services/privacy.service';

const MAX_IMAGE_COUNT = 10;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

type PreviewMedia = {
  url: string;
  type: 'IMAGE' | 'VIDEO';
  name?: string;
};

const isDocxFile = (file: File) =>
  file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
  file.name.toLowerCase().endsWith('.docx');

const getSelectedMediaType = (file: File): PendingChatMedia['type'] | null => {
  if (file.type.startsWith('image/')) return 'IMAGE';
  if (file.type.startsWith('video/')) return 'VIDEO';
  if (file.type === 'application/pdf' || isDocxFile(file)) return 'FILE';
  return null;
};

const formatBytes = (bytes?: number | null) => {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const getAttachmentName = (attachment: Attachment) => {
  const metadataName = attachment.metadata?.name;
  if (typeof metadataName === 'string' && metadataName.trim()) return metadataName;
  return attachment.type === 'FILE' ? 'Document' : 'Shared media';
};

const isPreviewableAttachment = (attachment: Attachment) =>
  attachment.type === 'IMAGE' || attachment.type === 'VIDEO';

const attachmentGridClass = (count: number) => {
  if (count <= 1) return 'grid-cols-1 max-w-[260px]';
  if (count === 2) return 'grid-cols-2 max-w-[320px]';
  return 'grid-cols-3 max-w-[360px]';
};

const sanitizeFileName = (name: string) =>
  name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'download';

const cloudinaryAttachmentUrl = (url: string, fileName: string) => {
  const uploadMarker = '/upload/';
  const markerIndex = url.indexOf(uploadMarker);
  if (markerIndex === -1) return url;
  const encodedName = encodeURIComponent(sanitizeFileName(fileName));
  return `${url.slice(0, markerIndex + uploadMarker.length)}fl_attachment:${encodedName}/${url.slice(markerIndex + uploadMarker.length)}`;
};

const downloadOriginalFile = async (url: string, fileName: string) => {
  const safeName = sanitizeFileName(fileName);
  try {
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) throw new Error('Download failed');
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = safeName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch {
    window.open(cloudinaryAttachmentUrl(url, safeName), '_blank', 'noopener,noreferrer');
  }
};

export default function Chat() {
  const { startCall, call: activeCall, busy: callBusy } = useVideoCall();
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { conversations, loadingConversations, onlineUsers } = useChat(user?.id);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [messageText, setMessageText] = useState('');
  const [selectedMedia, setSelectedMedia] = useState<PendingChatMedia[]>([]);
  const selectedMediaRef = useRef<PendingChatMedia[]>([]);
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const typingIdleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [errorDialog, setErrorDialog] = useState<{isOpen: boolean, message: string}>({isOpen: false, message: ''});
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [timeTick, setTimeTick] = useState(0);
  const [previewMedia, setPreviewMedia] = useState<PreviewMedia | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      setTimeTick(prev => prev + 1);
    }, 60000); // 1 minute
    return () => clearInterval(interval);
  }, []);

  // Mark selected conversation as read on select
  useEffect(() => {
    if (!selectedConversationId) return;

    const markRead = async () => {
      try {
        const { chatService } = await import('./services/chat.service');
        await chatService.markAsRead(selectedConversationId);
      } catch (err) {
        console.error("Failed to mark conversation as read:", err);
      }
    };
    markRead();

    queryClient.setQueryData(['conversations'], (old: Conversation[] | undefined) => {
      if (!old) return old;
      return old.map(c => c.id === selectedConversationId ? { ...c, unreadCount: 0 } : c);
    });
  }, [selectedConversationId, queryClient]);

  // Group Chat Creation state
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupSearchQuery, setGroupSearchQuery] = useState('');
  const [groupSearchResults, setGroupSearchResults] = useState<UserSearchResponse[]>([]);
  const [isGroupSearching, setIsGroupSearching] = useState(false);
  const [selectedMembers, setSelectedMembers] = useState<UserSearchResponse[]>([]);
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [showConversationSettings, setShowConversationSettings] = useState(false);
  const [groupNameDraft, setGroupNameDraft] = useState('');
  const [nicknameDrafts, setNicknameDrafts] = useState<Record<string, string>>({});
  const [isConversationActionLoading, setIsConversationActionLoading] = useState(false);
  const [blockWarningDialog, setBlockWarningDialog] = useState<{ isOpen: boolean; names: string[]; conversationId?: string }>({ isOpen: false, names: [] });
  const [leaveGroupConfirmOpen, setLeaveGroupConfirmOpen] = useState(false);
  const [destructiveConfirm, setDestructiveConfirm] = useState<{
    isOpen: boolean;
    action: 'deleteGroup' | 'kickParticipant' | null;
    participantId?: string;
    participantName?: string;
  }>({ isOpen: false, action: null });
  const [addMemberQuery, setAddMemberQuery] = useState('');
  const [addMemberResults, setAddMemberResults] = useState<UserSearchResponse[]>([]);
  const [isAddMemberSearching, setIsAddMemberSearching] = useState(false);
  const acknowledgedBlockWarningsRef = useRef<Set<string>>(new Set());

  const selectedConversation = useMemo(() => 
    conversations?.find(c => c.id === selectedConversationId),
    [conversations, selectedConversationId]
  );

  useEffect(() => {
    if (!selectedConversation) return;
    setGroupNameDraft(selectedConversation.name || '');
    setNicknameDrafts(Object.fromEntries(
      selectedConversation.participants.map(participant => [
        participant.userId,
        participant.nickname || participant.displayName || participant.username || '',
      ])
    ));
    setAddMemberQuery('');
    setAddMemberResults([]);
  }, [selectedConversation]);

  const { messages, loadingHistory, sendMessage, sendTyping, typingUsers } = 
    useConversationMessages(selectedConversationId, user?.id);

  useEffect(() => {
    if (!selectedConversation || selectedConversation.type !== 'GROUP' || !user?.id) return;
    if (acknowledgedBlockWarningsRef.current.has(selectedConversation.id)) return;

    let isMounted = true;
    const checkBlockedParticipants = async () => {
      const otherParticipants = selectedConversation.participants.filter(participant => participant.userId !== user.id);
      const statuses = await Promise.all(
        otherParticipants.map(async participant => {
          try {
            const status = await blockService.getBlockStatus(participant.userId);
            return status.blockedByViewer ? participant : null;
          } catch {
            return null;
          }
        })
      );
      const blockedParticipants = statuses.filter(Boolean) as Conversation['participants'];
      if (isMounted && blockedParticipants.length > 0) {
        acknowledgedBlockWarningsRef.current.add(selectedConversation.id);
        setBlockWarningDialog({
          isOpen: true,
          conversationId: selectedConversation.id,
          names: blockedParticipants.map(participant => participantName(participant)),
        });
      }
    };

    void checkBlockedParticipants();
    return () => {
      isMounted = false;
    };
  }, [selectedConversation, user?.id]);

  // Mark conversation as read when new message is received in active view
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
  useEffect(() => {
    if (selectedConversationId && messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.senderId !== user?.id) {
        const markRead = async () => {
          try {
            const { chatService } = await import('./services/chat.service');
            await chatService.markAsRead(selectedConversationId);
          } catch (err) {
            console.error("Failed to mark conversation as read on message:", err);
          }
        };
        markRead();

        queryClient.setQueryData(['conversations'], (old: Conversation[] | undefined) => {
          if (!old) return old;
          return old.map(c => c.id === selectedConversationId ? { ...c, unreadCount: 0 } : c);
        });
      }
    }
  }, [lastMessageId, selectedConversationId, user?.id, queryClient]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typingUsers]);

  useEffect(() => {
    selectedMediaRef.current = selectedMedia;
  }, [selectedMedia]);

  useEffect(() => {
    return () => {
      selectedMediaRef.current.forEach(item => URL.revokeObjectURL(item.previewUrl));
      if (typingIdleRef.current) clearTimeout(typingIdleRef.current);
    };
  }, []);

  const showError = (message: string) => {
    setErrorDialog({ isOpen: true, message });
  };

  const handleMediaSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files: File[] = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
    event.currentTarget.value = '';
    if (files.length === 0) return;

    const currentImageCount = selectedMedia.filter(item => item.type === 'IMAGE').length;
    let nextImageCount = currentImageCount;
    const accepted: PendingChatMedia[] = [];

    for (const file of files) {
      const mediaType = getSelectedMediaType(file);

      if (!mediaType) {
        showError('Only images, videos, PDF, and DOCX files can be sent in chat. Examples: project-brief.pdf or meeting-notes.docx.');
        continue;
      }

      if (mediaType === 'IMAGE') {
        if (file.size > MAX_IMAGE_BYTES) {
          showError('Images must be 50MB or smaller.');
          continue;
        }
        if (nextImageCount >= MAX_IMAGE_COUNT) {
          showError('You can send up to 10 images in one message.');
          continue;
        }
        nextImageCount += 1;
      }

      if (mediaType === 'VIDEO' && file.size > MAX_VIDEO_BYTES) {
        showError('Videos must be 500MB or smaller.');
        continue;
      }

      if (mediaType === 'FILE' && file.size > MAX_FILE_BYTES) {
        showError('PDF and DOCX files must be 50MB or smaller.');
        continue;
      }

      accepted.push({
        id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
        file,
        type: mediaType,
        previewUrl: URL.createObjectURL(file),
      });
    }

    if (accepted.length > 0) {
      setSelectedMedia(prev => [...prev, ...accepted]);
    }
  };

  const removeSelectedMedia = (mediaId: string) => {
    setSelectedMedia(prev => {
      const item = prev.find(media => media.id === mediaId);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return prev.filter(media => media.id !== mediaId);
    });
  };

  const handleMessageChange = (value: string) => {
    setMessageText(value);
    sendTyping(value.length > 0);
    if (typingIdleRef.current) clearTimeout(typingIdleRef.current);
    if (value.length > 0) {
      typingIdleRef.current = setTimeout(() => sendTyping(false), 1500);
    }
  };

  const handleSendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!selectedConversationId || isSendingMessage) return;
    if (!messageText.trim() && selectedMedia.length === 0) return;

    setIsSendingMessage(true);
    try {
      const attachments: Attachment[] = selectedMedia.length > 0
        ? (await (await import('./services/chat.service')).chatService.uploadMedia(selectedMedia.map(item => item.file))).map((upload, index) => {
            const source = selectedMedia[index];
            return {
              type: upload.type,
              url: upload.url,
              cloudinaryPublicId: upload.publicId || undefined,
              metadata: {
                width: upload.width,
                height: upload.height,
                format: upload.format,
                bytes: upload.bytes ?? source?.file.size,
                name: source?.file.name,
                contentType: source?.file.type,
              },
            };
          })
        : [];

      sendMessage(messageText, attachments);
      sendTyping(false);
      setMessageText('');
      setSelectedMedia(prev => {
        prev.forEach(item => URL.revokeObjectURL(item.previewUrl));
        return [];
      });
    } catch (err: any) {
      showError(err.response?.data?.message || 'Could not send media. Please try again.');
    } finally {
      setIsSendingMessage(false);
    }
  };

  const typingUserNames = useMemo(() => {
    if (!selectedConversation) return [];
    return Object.keys(typingUsers)
      .filter(id => typingUsers[id])
      .map(id => {
        const p = selectedConversation.participants.find(p => p.userId === id);
        return p?.displayName || p?.username || 'Someone';
      });
  }, [typingUsers, selectedConversation]);

  const isUserOnline = (userId: string) => !!onlineUsers[userId]?.isOnline;

  const formatLastSeen = (userId: string) => {
    const presence = onlineUsers[userId];
    if (!presence) return 'Offline';
    if (presence.isOnline) return 'Online';
    if (!presence.lastSeen) return 'Offline';
    
    const diffMs = Date.now() - presence.lastSeen;
    if (diffMs < 0) return 'Offline';
    
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Active just now';
    if (diffMins < 60) return `Active ${diffMins}m ago`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `Active ${diffHours}h ago`;
    
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return 'Active 1d ago';
    return `Active ${diffDays}d ago`;
  };

  const participantName = (participant?: Conversation['participants'][number]) => (
    participant?.nickname || participant?.displayName || participant?.username || 'Unknown'
  );

  const getConversationTitle = (conv: Conversation) => {
    if (conv.type === 'GROUP') return conv.name || 'Group Chat';
    const otherParticipant = conv.participants.find(p => p.userId !== user?.id);
    return participantName(otherParticipant);
  };

  const getConversationAvatar = (conv: Conversation) => {
    if (conv.type === 'GROUP') return 'https://ui-avatars.com/api/?name=Group';
    const otherParticipant = conv.participants.find(p => p.userId !== user?.id);
    return otherParticipant?.avatarUrl || `https://ui-avatars.com/api/?name=${otherParticipant?.username || '?'}`;
  };

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [directChatNotice, setDirectChatNotice] = useState('');
  const [directChatNoticeSeconds, setDirectChatNoticeSeconds] = useState(0);
  const [directMessageAllowed, setDirectMessageAllowed] = useState(true);

  useEffect(() => {
    if (!directChatNotice) return;
    const timer = window.setInterval(() => {
      setDirectChatNoticeSeconds((seconds) => {
        if (seconds <= 1) {
          window.clearInterval(timer);
          setDirectChatNotice('');
          return 0;
        }
        return seconds - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [directChatNotice]);

  useEffect(() => {
    if (!selectedConversation || selectedConversation.type !== 'DIRECT' || !user?.id) {
      setDirectMessageAllowed(true);
      return;
    }

    const recipient = selectedConversation.participants.find(participant => participant.userId !== user.id);
    if (!recipient) return;
    let active = true;
    setDirectMessageAllowed(true);
    privacyService.canSendDirectMessage(recipient.userId)
      .then((allowed) => {
        if (active) setDirectMessageAllowed(allowed);
      })
      .catch(() => {
        if (active) setDirectMessageAllowed(false);
      });
    return () => {
      active = false;
    };
  }, [selectedConversation, user?.id]);

  // Handle Search
  useEffect(() => {
    const timer = setTimeout(async () => {
      if (searchQuery.trim().length >= 2) {
        setIsSearching(true);
        try {
          // import { friendService } from './services/friend.service';
          const { friendService } = await import('./services/friend.service');
          const results = await friendService.searchUsers(searchQuery);
          setSearchResults(results.filter(result => result.id !== user?.id));
        } catch (err) {
          console.error('Search error', err);
        } finally {
          setIsSearching(false);
        }
      } else {
        setSearchResults([]);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [searchQuery, user?.id]);

  // Group chat user search
  useEffect(() => {
    const timer = setTimeout(async () => {
      if (groupSearchQuery.trim().length >= 2) {
        setIsGroupSearching(true);
        try {
          const { friendService } = await import('./services/friend.service');
          const results = await friendService.searchUsers(groupSearchQuery);
          // Filter out already selected members and self
          const filtered = results.filter(
            r => r.id !== user?.id && !selectedMembers.some(m => m.id === r.id)
          );
          setGroupSearchResults(filtered);
        } catch (err) {
          console.error('Group search error', err);
        } finally {
          setIsGroupSearching(false);
        }
      } else {
        setGroupSearchResults([]);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [groupSearchQuery, selectedMembers, user?.id]);

  useEffect(() => {
    if (!showConversationSettings || !selectedConversation || selectedConversation.type !== 'GROUP' || !selectedConversation.currentUserAdmin) {
      setAddMemberResults([]);
      setIsAddMemberSearching(false);
      return;
    }

    const query = addMemberQuery.trim();
    if (query.length < 2) {
      setAddMemberResults([]);
      setIsAddMemberSearching(false);
      return;
    }

    const timer = setTimeout(async () => {
      setIsAddMemberSearching(true);
      try {
        const { friendService } = await import('./services/friend.service');
        const results = await friendService.searchUsers(query);
        const existingIds = new Set(selectedConversation.participants.map(participant => participant.userId));
        setAddMemberResults(results.filter(result => !existingIds.has(result.id) && result.id !== user?.id));
      } catch (err) {
        console.error('Add member search error', err);
        setAddMemberResults([]);
      } finally {
        setIsAddMemberSearching(false);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [addMemberQuery, selectedConversation, showConversationSettings, user?.id]);
  const handleAddMember = (member: UserSearchResponse) => {
    setSelectedMembers(prev => [...prev, member]);
    setGroupSearchQuery('');
    setGroupSearchResults([]);
  };

  const handleRemoveMember = (memberId: string) => {
    setSelectedMembers(prev => prev.filter(m => m.id !== memberId));
  };

  const handleCreateGroupChat = async () => {
    if (!groupName.trim() || selectedMembers.length < 2) return;
    setIsCreatingGroup(true);
    try {
      const { chatService } = await import('./services/chat.service');
      const participantIds = selectedMembers.map(m => m.id);
      const conv = await chatService.createGroupConversation(groupName, participantIds);
      
      queryClient.setQueryData(['conversations'], (old: Conversation[] | undefined) => {
        if (!old) return [conv];
        return [conv, ...old];
      });

      setSelectedConversationId(conv.id);
      // Reset modal state
      setShowCreateGroup(false);
      setGroupName('');
      setSelectedMembers([]);
      setGroupSearchQuery('');
    } catch (err: any) {
      setErrorDialog({
        isOpen: true,
        message: err.response?.data?.message || 'Could not create group chat'
      });
    } finally {
      setIsCreatingGroup(false);
    }
  };

  const handleCloseCreateGroup = () => {
    setShowCreateGroup(false);
    setGroupName('');
    setSelectedMembers([]);
    setGroupSearchQuery('');
    setGroupSearchResults([]);
  };

  const closeConversationSettings = () => setShowConversationSettings(false);

  const updateConversationCache = (conversation: Conversation) => {
    queryClient.setQueryData(['conversations'], (old: Conversation[] | undefined) => {
      if (!old) return [conversation];
      return old.map(item => item.id === conversation.id ? conversation : item);
    });
  };

  const removeConversationFromCache = (conversationId: string) => {
    queryClient.setQueryData(['conversations'], (old: Conversation[] | undefined) => old?.filter(item => item.id !== conversationId) || []);
    if (selectedConversationId === conversationId) {
      setSelectedConversationId(null);
    }
  };

  const runConversationAction = async (action: () => Promise<void>) => {
    setIsConversationActionLoading(true);
    try {
      await action();
    } catch (err: any) {
      showError(err.response?.data?.message || 'Could not update this conversation. Please try again.');
    } finally {
      setIsConversationActionLoading(false);
    }
  };

  const handleRenameGroup = () => {
    if (!selectedConversation || selectedConversation.type !== 'GROUP') return;
    void runConversationAction(async () => {
      const updated = await chatService.updateGroupName(selectedConversation.id, groupNameDraft);
      updateConversationCache(updated);
    });
  };

  const handleDeleteGroup = () => {
    if (!selectedConversation || selectedConversation.type !== 'GROUP') return;
    setDestructiveConfirm({ isOpen: true, action: 'deleteGroup' });
  };

  const handleLeaveGroup = () => {
    if (!selectedConversation || selectedConversation.type !== 'GROUP') return;
    setLeaveGroupConfirmOpen(true);
  };

  const confirmLeaveGroup = () => {
    if (!selectedConversation || selectedConversation.type !== 'GROUP') return;
    const conversationId = selectedConversation.id;
    setLeaveGroupConfirmOpen(false);
    void runConversationAction(async () => {
      await chatService.leaveGroup(conversationId);
      removeConversationFromCache(conversationId);
      closeConversationSettings();
    });
  };

  const handleMakeAdmin = (participantId: string) => {
    if (!selectedConversation) return;
    void runConversationAction(async () => {
      const updated = await chatService.makeAdmin(selectedConversation.id, participantId);
      updateConversationCache(updated);
    });
  };

  const handleKickParticipant = (participantId: string) => {
    if (!selectedConversation) return;
    const participant = selectedConversation.participants.find(item => item.userId === participantId);
    setDestructiveConfirm({
      isOpen: true,
      action: 'kickParticipant',
      participantId,
      participantName: participantName(participant),
    });
  };

  const confirmDestructiveAction = () => {
    if (!selectedConversation || !destructiveConfirm.action) return;
    const conversationId = selectedConversation.id;
    const action = destructiveConfirm.action;
    const participantId = destructiveConfirm.participantId;
    setDestructiveConfirm({ isOpen: false, action: null });

    void runConversationAction(async () => {
      if (action === 'deleteGroup') {
        await chatService.deleteGroup(conversationId);
        removeConversationFromCache(conversationId);
        closeConversationSettings();
        return;
      }

      if (action === 'kickParticipant' && participantId) {
        const updated = await chatService.removeParticipant(conversationId, participantId);
        updateConversationCache(updated);
      }
    });
  };

  const handleAddGroupParticipant = (member: UserSearchResponse) => {
    if (!selectedConversation || selectedConversation.type !== 'GROUP') return;
    void runConversationAction(async () => {
      const updated = await chatService.addParticipant(selectedConversation.id, member.id);
      updateConversationCache(updated);
      setAddMemberQuery('');
      setAddMemberResults([]);
    });
  };

  const handleDownloadAttachment = async (url: string, fileName: string) => {
    await downloadOriginalFile(url, fileName);
  };
  const handleSaveNickname = (participantId: string) => {
    if (!selectedConversation) return;
    void runConversationAction(async () => {
      const updated = await chatService.updateNickname(selectedConversation.id, participantId, nicknameDrafts[participantId] || '');
      updateConversationCache(updated);
    });
  };

  useEscapeKey(showCreateGroup, handleCloseCreateGroup);
  useEscapeKey(showConversationSettings, closeConversationSettings);
  useEscapeKey(!!previewMedia, () => setPreviewMedia(null));

  const handleStartConversation = async (otherUser: any) => {
    setDirectChatNotice('');
    try {
      const { chatService } = await import('./services/chat.service');
      const conv = await chatService.getOrCreateDirectConversation(otherUser.userId || otherUser.id);
      
      // Manually update conversations cache with the new conversation
      queryClient.setQueryData(['conversations'], (old: Conversation[] | undefined) => {
        if (!old) return [conv];
        // Check if conversation already exists
        const exists = old.some(c => c.id === conv.id);
        if (exists) return old;
        // Add new conversation at the beginning
        return [conv, ...old];
      });
      
      setSelectedConversationId(conv.id);
      setSearchQuery('');
      setSearchResults([]);
    } catch (err: any) {
      const message = err.response?.data?.message || 'Could not start conversation';
      setDirectChatNotice(message);
      setDirectChatNoticeSeconds(5);
    }
  };

  // Deep link from elsewhere (e.g. profile hover card): /chat?userId=<id>
  const targetUserId = searchParams.get('userId');
  useEffect(() => {
    if (!targetUserId || !user?.id) return;
    setSearchParams({}, { replace: true });
    handleStartConversation({ id: targetUserId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId, user?.id]);

  return (
    <Layout>
      <div className="bg-surface text-on-surface min-h-screen selection:bg-primary-container selection:text-on-primary-container pb-20 md:pb-0 h-screen flex flex-col">
        
        {/* Top App Bar (Mobile Content Header) */}
        <header className="md:hidden flex justify-between items-center px-6 py-4 w-full sticky top-0 z-50 bg-surface/80 backdrop-blur-md shadow-sm shrink-0">
          <div className="flex items-center gap-4">
            <button className="p-2 flex-col items-center gap-1 text-primary-container">
              <Menu size={24} />
            </button>
            <h2 className="text-xl font-bold text-primary truncate">Moments</h2>
          </div>
          
          <div className="flex items-center gap-2 shrink-0">
            <button className="p-2 text-on-surface-variant hover:bg-primary-container/20 rounded-full transition-colors active:scale-95">
              <Bell size={24} />
            </button>
          </div>
        </header>

        {/* Desktop Header */}
        <header className="hidden md:flex justify-between items-center px-8 py-4 w-full sticky top-0 z-50 bg-surface/80 backdrop-blur-md shadow-sm shrink-0">
          <div className="flex items-center gap-6">
            <span className="text-2xl font-bold text-primary tracking-tight">Moments</span>
            <div className="hidden lg:flex items-center bg-surface-container-low px-4 py-2 rounded-full gap-2 w-72 border border-outline-variant/20 focus-within:border-primary-container focus-within:ring-2 focus-within:ring-primary-container/20 transition-all">
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-full overflow-hidden border-2 border-primary-container shrink-0 ml-2">
              <img 
                alt="User Profile" 
                className="w-full h-full object-cover" 
                src={user?.avatarUrl || 'https://ui-avatars.com/api/?name=User'}
                referrerPolicy="no-referrer"
              />
            </div>
          </div>
        </header>

        <div className="flex-1 w-full max-w-[1440px] mx-auto px-4 md:px-8 pb-4 flex flex-col md:flex-row gap-6 overflow-hidden md:h-[calc(100vh-80px)]">
          {/* Conversation List Sidebar */}
          <section className="flex flex-col w-full md:w-[320px] lg:w-[380px] bg-surface-container-low md:h-full rounded-[2rem] overflow-hidden border border-surface-container shrink-0 shadow-[0_4px_20px_rgba(28,28,24,0.03)] h-[400px] md:h-auto">
            <div className="p-6 shrink-0">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-2xl font-bold text-on-surface tracking-tight">Messages</h2>
                <button 
                  onClick={() => setShowCreateGroup(true)}
                  className="p-2.5 bg-primary text-white rounded-full hover:bg-primary/90 transition-all active:scale-95 shadow-md hover:shadow-lg hover:-translate-y-0.5"
                  title="Create Group Chat"
                >
                  <Users size={18} />
                </button>
              </div>
              <div className="relative">
                <input 
                  type="text" 
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setDirectChatNotice('');
                  }}
                  placeholder="Search a username to start a chat..."
                  className="w-full bg-surface-container-lowest border-2 border-transparent focus:border-tertiary-container rounded-full px-4 py-2.5 pl-11 text-sm font-medium focus:ring-0 transition-all outline-none text-on-surface placeholder:text-on-surface-variant"
                />
                <Search size={18} className="absolute left-4 top-3 text-outline-variant" />
                
                {/* Search Results Overlay */}
                {searchQuery.trim().length >= 2 && (
                  <div className="absolute top-full left-0 right-0 mt-2 bg-surface-container-highest rounded-2xl shadow-xl z-50 overflow-hidden border border-outline-variant/20">
                    {isSearching ? (
                      <div className="p-4 flex justify-center"><Loader2 className="animate-spin text-primary" size={20} /></div>
                    ) : searchResults.length > 0 ? (
                      searchResults.map(res => (
                        <div 
                          key={res.id || res.userId}
                          onClick={() => handleStartConversation(res)}
                          className="flex items-center gap-3 p-3 hover:bg-primary-container/20 cursor-pointer transition-colors border-b border-outline-variant/10 last:border-0"
                        >
                          <img src={res.avatarUrl || `https://ui-avatars.com/api/?name=${res.username}`} className="w-10 h-10 rounded-full shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm font-bold text-on-surface truncate">{res.displayName || res.username}</p>
                            <p className="text-xs text-on-surface-variant truncate">@{res.username}</p>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="p-4 text-center text-sm text-on-surface-variant">No users found</div>
                    )}
                  </div>
                )}
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-outline-variant/30 scrollbar-track-transparent px-4 pb-4">
              
              {loadingConversations ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="animate-spin text-primary" size={32} />
                </div>
              ) : conversations?.map(conv => (
                <div 
                  key={conv.id}
                  onClick={() => setSelectedConversationId(conv.id)}
                  className={`flex items-center gap-4 p-3 mb-2 rounded-2xl cursor-pointer transition-all hover:bg-surface-container-high group ${selectedConversationId === conv.id ? 'bg-surface-container-highest/60' : ''}`}
                >
                  <div className="relative shrink-0">
                    <img 
                      src={getConversationAvatar(conv)} 
                      alt={getConversationTitle(conv)} 
                      className="w-12 h-12 rounded-full object-cover border border-outline-variant/20"
                      referrerPolicy="no-referrer"
                    />
                    {conv.type === 'DIRECT' && isUserOnline(conv.participants.find(p => p.userId !== user?.id)?.userId || '') && (
                      <span className="absolute bottom-0.5 right-0 w-3.5 h-3.5 bg-green-500 border-2 border-surface-container-low rounded-full"></span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-center mb-0.5">
                      <h3 className="font-bold text-sm text-on-surface truncate pr-2 group-hover:text-primary transition-colors">
                        {getConversationTitle(conv)}
                      </h3>
                      <span className="text-xs font-bold text-outline shrink-0">
                        {conv.lastMessage ? new Date(conv.lastMessage.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                      </span>
                    </div>
                    <p className={`text-sm truncate ${conv.unreadCount > 0 ? 'font-bold text-primary' : 'font-medium text-on-surface-variant'}`}>
                      {conv.lastMessage ? `${conv.lastMessage.senderId === user?.id ? 'You: ' : ''}${conv.lastMessage.content || (conv.lastMessage.type === 'VIDEO' ? 'Sent a video' : conv.lastMessage.type === 'IMAGE' ? 'Sent media' : '')}` : 'No messages yet'}
                    </p>
                  </div>
                  {conv.unreadCount > 0 && (
                    <span className="bg-primary text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                      {conv.unreadCount}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* Active Chat Window */}
          <section className="flex flex-col flex-1 bg-surface-container-lowest md:h-full rounded-[2rem] overflow-hidden shadow-[0_12px_40px_-12px_rgba(139,78,62,0.15)] border border-surface-container h-[600px] md:h-auto z-10 relative">
            
            {!selectedConversationId ? (
              <div className="flex-1 flex flex-col items-center justify-center p-10 text-center opacity-60">
                <div className="bg-primary-container/20 p-6 rounded-full mb-6">
                  <MessageSquare size={64} className="text-primary opacity-40" />
                </div>
                <h3 className="text-xl font-bold text-on-surface mb-2">Your Space</h3>
                <p className="max-w-xs mx-auto text-sm font-medium">Select a friend to start sharing moments and memories in real-time.</p>
              </div>
            ) : (
              <>
                {/* Chat Header */}
                <header className="h-20 px-6 flex items-center justify-between border-b border-surface-container bg-surface-container-lowest shrink-0">
                  <div className="flex items-center gap-4">
                    <div className="relative">
                      <img 
                        src={getConversationAvatar(selectedConversation!)} 
                        alt={getConversationTitle(selectedConversation!)} 
                        className="w-11 h-11 rounded-full object-cover border border-outline-variant/20"
                        referrerPolicy="no-referrer"
                      />
                      {selectedConversation!.type === 'DIRECT' && isUserOnline(selectedConversation!.participants.find(p => p.userId !== user?.id)?.userId || '') && (
                        <span className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-green-500 border-2 border-surface-container-lowest rounded-full"></span>
                      )}
                    </div>
                    <div>
                      <h3 className="text-xl font-bold text-on-surface tracking-tight leading-none mb-1">
                        {getConversationTitle(selectedConversation!)}
                      </h3>
                       <p className={`text-xs font-bold ${selectedConversation!.type === 'DIRECT' && isUserOnline(selectedConversation!.participants.find(p => p.userId !== user?.id)?.userId || '') ? 'text-tertiary' : 'text-outline'}`}>
                        {selectedConversation!.type === 'DIRECT' 
                          ? formatLastSeen(selectedConversation!.participants.find(p => p.userId !== user?.id)?.userId || '')
                          : `${selectedConversation!.participants.length} members`
                        }
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {selectedConversation?.type === 'DIRECT' && <button type="button"
                      onClick={() => void startCall(selectedConversation)}
                      disabled={callBusy || !directMessageAllowed || (!!activeCall && activeCall.status !== 'ENDED')}
                      title="Start video call" aria-label="Start video call"
                      className="p-2 md:p-3 text-primary hover:bg-surface-container transition-colors rounded-full active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed">
                      {callBusy ? <Loader2 size={20} className="animate-spin" /> : <Video size={20} />}
                    </button>}
                    <button
                      type="button"
                      onClick={() => setShowConversationSettings(true)}
                      className="hidden md:block p-3 text-on-surface-variant hover:bg-surface-container transition-colors rounded-full active:scale-95"
                      title="Conversation details"
                    >
                      <Info size={20} />
                    </button>
                  </div>
                </header>

                {/* Message Area */}
                <div className="flex-1 overflow-y-auto p-4 md:p-6 flex flex-col gap-6 scroll-smooth bg-surface-bright pb-32 md:pb-6">
                  {loadingHistory && (
                    <div className="flex justify-center py-4">
                      <Loader2 className="animate-spin text-primary opacity-40" size={24} />
                    </div>
                  )}

                  {messages.map((msg) => {
                    const sender = selectedConversation?.participants.find(p => p.userId === msg.senderId);
                    const senderName = sender ? participantName(sender) : msg.senderName || 'Unknown';
                    const senderAvatar = msg.senderAvatar || sender?.avatarUrl || `https://ui-avatars.com/api/?name=${senderName}`;

                    if (msg.type === MessageType.SYSTEM) {
                      return (
                        <div key={msg.id} className="mx-auto flex max-w-[90%] flex-col items-center gap-1 text-center">
                          <div className="rounded-full bg-surface-container-high px-3 py-1.5 text-xs font-bold text-on-surface-variant shadow-sm">
                            {msg.content}
                          </div>
                          <span className="text-[11px] font-semibold text-outline-variant">
                            {new Date(msg.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      );
                    }

                    return (
                      <div key={msg.id} className={`flex gap-3 max-w-[85%] md:max-w-[70%] ${msg.senderId === user?.id ? 'flex-row-reverse ml-auto' : ''}`}>
                        <img 
                          src={senderAvatar} 
                          alt={senderName} 
                          className="w-8 h-8 rounded-full object-cover mt-2 shrink-0 border border-outline-variant/20"
                          referrerPolicy="no-referrer"
                        />
                        <div className={`flex flex-col ${msg.senderId === user?.id ? 'items-end' : ''}`}>
                          {selectedConversation?.type === 'GROUP' && msg.senderId !== user?.id && (
                            <span className="text-[11px] font-bold text-primary mb-1 ml-1 leading-none">
                              {senderName}
                            </span>
                          )}
                          <div className={`
                          p-4 shadow-sm
                          ${msg.senderId === user?.id 
                            ? 'bg-primary-container text-on-primary-container rounded-[1.5rem] rounded-tr-sm' 
                            : 'bg-surface-container text-on-surface rounded-[1.5rem] rounded-tl-sm'
                          }
                          ${msg.attachments?.[0] ? 'p-2' : ''}
                        `}>
                          {msg.attachments?.length ? (
                            <div className="space-y-2 w-fit max-w-full">
                              <div className={`grid gap-1.5 ${attachmentGridClass(msg.attachments.length)}`}>
                                {msg.attachments.map((attachment, index) => {
                                  const attachmentName = getAttachmentName(attachment);
                                  const attachmentBytes = formatBytes(attachment.metadata?.bytes);

                                  if (attachment.type === 'FILE') {
                                    return (
                                      <div key={`${attachment.url}-${index}`} className="col-span-full flex min-w-[220px] max-w-[320px] items-center gap-3 rounded-xl bg-surface-container-high p-3 shadow-sm">
                                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-container text-primary">
                                          <FileText size={22} />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                          <p className="truncate text-sm font-bold">{attachmentName}</p>
                                          {attachmentBytes && <p className="text-xs font-semibold opacity-70">{attachmentBytes}</p>}
                                        </div>
                                        <button
                                          type="button"
                                          onClick={() => void handleDownloadAttachment(attachment.url, attachmentName)}
                                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-container-lowest/80 hover:bg-surface-container-lowest"
                                          title="Download file"
                                          aria-label={`Download ${attachmentName}`}
                                        >
                                          <Download size={17} />
                                        </button>
                                      </div>
                                    );
                                  }

                                  const previewType = attachment.type === 'VIDEO' ? 'VIDEO' : 'IMAGE';
                                  return (
                                    <div key={`${attachment.url}-${index}`} className="group relative aspect-square overflow-hidden bg-surface-container-high shadow-sm">
                                      <button
                                        type="button"
                                        onClick={() => setPreviewMedia({ url: attachment.url, type: previewType, name: attachmentName })}
                                        className="h-full w-full"
                                        aria-label={`Preview ${attachmentName}`}
                                      >
                                        {attachment.type === 'VIDEO' ? (
                                          <video
                                            src={attachment.url}
                                            className="w-full h-full object-cover"
                                            muted
                                          />
                                        ) : (
                                          <img
                                            src={attachment.url}
                                            alt={attachmentName}
                                            className="w-full h-full object-cover"
                                            referrerPolicy="no-referrer"
                                          />
                                        )}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          void handleDownloadAttachment(attachment.url, attachmentName);
                                        }}
                                        className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity hover:bg-black/75 group-hover:opacity-100 focus:opacity-100"
                                        title="Download media"
                                        aria-label={`Download ${attachmentName}`}
                                      >
                                        <Download size={14} />
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                              {msg.content?.trim() && (
                                <p className="text-sm md:text-base font-medium leading-relaxed px-2 pb-1">{msg.content}</p>
                              )}
                            </div>
                          ) : (
                            <p className="text-sm md:text-base font-medium leading-relaxed">{msg.content}</p>
                          )}
                        </div>
                        <span className="text-xs font-bold text-outline-variant mt-1.5 px-1">
                          {new Date(msg.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        </div>
                      </div>
                    );
                  })}

                  {/* Typing Indicator */}
                  {typingUserNames.length > 0 && (
                    <div className="flex gap-3 max-w-[80%] animate-pulse duration-1000">
                      <div className="w-8 h-8 rounded-full bg-primary-container/30 border border-outline-variant/20 flex items-center justify-center shrink-0 mt-2">
                        <Edit3 size={14} className="text-primary" />
                      </div>
                      <div className="bg-tertiary-container text-on-tertiary-container px-4 py-3 rounded-full rounded-tl-none shadow-sm flex items-center gap-2">
                        <p className="text-xs md:text-sm font-bold">
                          {typingUserNames.length === 1 
                            ? `${typingUserNames[0]} is typing...`
                            : typingUserNames.length > 1
                            ? `${typingUserNames.slice(0, -1).join(', ')} and ${typingUserNames.slice(-1)} are typing...`
                            : ''}
                        </p>
                      </div>
                    </div>
                  )}

                  <div ref={chatEndRef} />
                </div>

                {/* Input Area */}
                <div className="p-4 md:p-6 border-t border-surface-container bg-surface-container-lowest shrink-0 absolute bottom-0 left-0 right-0 z-20 md:relative">
                  {selectedMedia.length > 0 && (
                    <div className="mb-3 grid grid-cols-2 sm:grid-cols-5 gap-2 max-h-44 overflow-y-auto pr-1">
                      {selectedMedia.map(media => (
                        <div key={media.id} className="relative min-h-24 overflow-hidden bg-surface-container-high border border-outline-variant/20">
                          {media.type === 'VIDEO' ? (
                            <video src={media.previewUrl} className="h-full min-h-24 w-full object-cover" muted />
                          ) : media.type === 'IMAGE' ? (
                            <img src={media.previewUrl} alt="Selected media" className="h-full min-h-24 w-full object-cover" />
                          ) : (
                            <div className="flex h-full min-h-24 items-center gap-3 p-3">
                              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-container text-primary">
                                <FileText size={20} />
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-xs font-bold text-on-surface">{media.file.name}</p>
                                <p className="text-[11px] font-semibold text-on-surface-variant">{formatBytes(media.file.size)}</p>
                              </div>
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => removeSelectedMedia(media.id)}
                            className="absolute top-1 right-1 p-1 bg-black/60 text-white rounded-full hover:bg-error transition-colors"
                            title="Remove media"
                          >
                            <X size={14} />
                          </button>
                          <span className="absolute left-1 bottom-1 p-1 bg-black/50 text-white rounded-full">
                            {media.type === 'VIDEO' ? <Video size={13} /> : media.type === 'IMAGE' ? <ImageIcon size={13} /> : <FileText size={13} />}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {!directMessageAllowed && selectedConversation?.type === 'DIRECT' && (
                    <div role="status" className="mb-3 rounded-2xl bg-secondary-container px-4 py-3 text-sm font-bold text-on-secondary-container">
                      This person does not accept messages from people who are not friends.
                    </div>
                  )}
                  <form
                    onSubmit={handleSendMessage}
                    className="flex items-center gap-2 md:gap-4 bg-surface-container-low p-2 pr-2.5 rounded-full border-2 border-transparent focus-within:border-primary-container focus-within:bg-surface-container-lowest transition-all shadow-sm"
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*,video/*,application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      multiple
                      onChange={handleMediaSelect}
                      disabled={!directMessageAllowed}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={!directMessageAllowed}
                      className="p-2.5 text-primary hover:bg-primary-container/20 rounded-full transition-colors shrink-0"
                      title="Attach images, videos, PDF, or DOCX files"
                    >
                      <PlusCircle size={22} />
                    </button>
                    <input
                      type="text"
                      value={messageText}
                      onChange={(e) => handleMessageChange(e.target.value)}
                      onBlur={() => sendTyping(false)}
                      disabled={!directMessageAllowed}
                      placeholder={directMessageAllowed ? 'Write a warm message...' : 'Messaging is unavailable'}
                      className="flex-1 bg-transparent border-none focus:ring-0 text-sm md:text-base font-medium py-2 px-1 outline-none text-on-surface placeholder:text-on-surface-variant/70 min-w-0"
                    />
                    <div className="flex items-center gap-1 md:gap-2 shrink-0">
                      <button
                        type="button"
                        className="p-2 text-on-surface-variant hover:bg-surface-container-high rounded-full transition-colors hidden sm:block"
                      >
                        <Smile size={22} />
                      </button>
                      <button
                        type="submit"
                        disabled={!directMessageAllowed || isSendingMessage || (!messageText.trim() && selectedMedia.length === 0)}
                        className={`p-3 rounded-full transition-all flex items-center justify-center shrink-0 ${
                          !isSendingMessage && (messageText.trim() || selectedMedia.length > 0)
                            ? 'bg-primary text-white shadow-[0_4px_12px_rgba(139,78,62,0.3)] hover:-translate-y-0.5 active:scale-95'
                            : 'bg-primary-container text-on-primary-container/50 shadow-sm cursor-not-allowed'
                        }`}
                      >
                        {isSendingMessage ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} className="ml-0.5" />}
                      </button>
                    </div>
                  </form>
                </div>
              </>
            )}
            
          </section>

        </div>

        {/* Create Group Chat Modal */}
        {showCreateGroup && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            {/* Backdrop */}
            <div 
              className="absolute inset-0 bg-black/50 backdrop-blur-sm"
              onClick={handleCloseCreateGroup}
            />
            
            {/* Modal */}
            <div className="relative bg-surface-container-lowest rounded-[2rem] shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden border border-outline-variant/20 animate-in fade-in zoom-in-95 duration-200">
              {/* Modal Header */}
              <div className="px-6 pt-6 pb-4 border-b border-outline-variant/10 shrink-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 bg-primary-container rounded-full">
                      <Users size={20} className="text-primary" />
                    </div>
                    <h3 className="text-xl font-bold text-on-surface tracking-tight">New Group Chat</h3>
                  </div>
                  <button 
                    onClick={handleCloseCreateGroup}
                    className="p-2 hover:bg-surface-container-high rounded-full transition-colors text-on-surface-variant"
                  >
                    <X size={20} />
                  </button>
                </div>
                <p className="text-sm text-on-surface-variant font-medium ml-[52px]">Add at least 2 members to create a group</p>
              </div>

              {/* Modal Body */}
              <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
                {/* Group Name Input */}
                <div>
                  <label className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2 block">Group Name</label>
                  <input
                    type="text"
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    placeholder="e.g. Project Team, Study Group..."
                    className="w-full bg-surface-container-low border-2 border-transparent focus:border-primary rounded-xl px-4 py-3 text-sm font-medium focus:ring-0 transition-all outline-none text-on-surface placeholder:text-on-surface-variant/60"
                    autoFocus
                  />
                </div>

                {/* Selected Members Chips */}
                {selectedMembers.length > 0 && (
                  <div>
                    <label className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2 block">
                      Members ({selectedMembers.length})
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {selectedMembers.map(member => (
                        <div 
                          key={member.id}
                          className="flex items-center gap-2 bg-primary-container/30 text-on-surface pl-1 pr-2 py-1 rounded-full group hover:bg-primary-container/50 transition-colors"
                        >
                          <img 
                            src={member.avatarUrl || `https://ui-avatars.com/api/?name=${member.username}&background=random`}
                            alt={member.username}
                            className="w-6 h-6 rounded-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                          <span className="text-xs font-bold truncate max-w-[100px]">
                            {member.displayName || member.username}
                          </span>
                          <button 
                            onClick={() => handleRemoveMember(member.id)}
                            className="p-0.5 hover:bg-error/20 rounded-full transition-colors text-on-surface-variant hover:text-error"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Search Users to Add */}
                <div>
                  <label className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2 block">Search People</label>
                  <div className="relative">
                    <input
                      type="text"
                      value={groupSearchQuery}
                      onChange={(e) => setGroupSearchQuery(e.target.value)}
                      placeholder="Type a name to search..."
                      className="w-full bg-surface-container-low border-2 border-transparent focus:border-tertiary-container rounded-xl px-4 py-3 pl-11 text-sm font-medium focus:ring-0 transition-all outline-none text-on-surface placeholder:text-on-surface-variant/60"
                    />
                    <Search size={18} className="absolute left-4 top-3.5 text-outline-variant" />
                  </div>

                  {/* Search Results */}
                  {groupSearchQuery.trim().length >= 2 && (
                    <div className="mt-2 bg-surface-container-high rounded-xl overflow-hidden border border-outline-variant/10 max-h-[200px] overflow-y-auto">
                      {isGroupSearching ? (
                        <div className="p-4 flex justify-center">
                          <Loader2 className="animate-spin text-primary" size={20} />
                        </div>
                      ) : groupSearchResults.length > 0 ? (
                        groupSearchResults.map(result => (
                          <div
                            key={result.id}
                            onClick={() => handleAddMember(result)}
                            className="flex items-center gap-3 p-3 hover:bg-primary-container/20 cursor-pointer transition-colors border-b border-outline-variant/5 last:border-0"
                          >
                            <img 
                              src={result.avatarUrl || `https://ui-avatars.com/api/?name=${result.username}&background=random`}
                              alt={result.username}
                              className="w-10 h-10 rounded-full object-cover shrink-0"
                              referrerPolicy="no-referrer"
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-bold text-on-surface truncate">{result.displayName || result.username}</p>
                              <p className="text-xs text-on-surface-variant truncate">@{result.username}</p>
                            </div>
                            <div className="p-1.5 bg-primary-container/30 rounded-full text-primary shrink-0">
                              <UserPlus size={16} />
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="p-4 text-center text-sm text-on-surface-variant">No users found</div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Modal Footer */}
              <div className="px-6 py-4 border-t border-outline-variant/10 shrink-0 flex justify-end gap-3">
                <button
                  onClick={handleCloseCreateGroup}
                  className="px-5 py-2.5 text-sm font-bold text-on-surface-variant hover:bg-surface-container-high rounded-full transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateGroupChat}
                  disabled={!groupName.trim() || selectedMembers.length < 2 || isCreatingGroup}
                  className={`px-6 py-2.5 text-sm font-bold rounded-full transition-all flex items-center gap-2 ${
                    groupName.trim() && selectedMembers.length >= 2 && !isCreatingGroup
                      ? 'bg-primary text-white shadow-md hover:shadow-lg hover:-translate-y-0.5 active:scale-95'
                      : 'bg-surface-container-high text-on-surface-variant/50 cursor-not-allowed'
                  }`}
                >
                  {isCreatingGroup ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      Creating...
                    </>
                  ) : (
                    <>
                      <Check size={16} />
                      Create Group
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
        {/* Conversation Details Modal */}
        {showConversationSettings && selectedConversation && (
          <div className="fixed inset-0 z-[105] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={closeConversationSettings} />
            <div className="relative flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-[2rem] border border-outline-variant/20 bg-surface-container-lowest shadow-2xl">
              <div className="flex items-center justify-between border-b border-outline-variant/10 px-6 py-5">
                <div>
                  <h3 className="text-xl font-bold text-on-surface">Conversation details</h3>
                  <p className="text-sm font-semibold text-on-surface-variant">{getConversationTitle(selectedConversation)}</p>
                </div>
                <button type="button" onClick={closeConversationSettings} className="p-2 text-on-surface-variant hover:bg-surface-container-high rounded-full">
                  <X size={20} />
                </button>
              </div>

              <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
                {selectedConversation.type === 'GROUP' && (
                  <div className="rounded-2xl bg-surface-container-low p-4">
                    <label className="mb-2 block text-xs font-bold uppercase tracking-wide text-on-surface-variant">Group name</label>
                    <div className="flex gap-2">
                      <input
                        value={groupNameDraft}
                        onChange={(event) => setGroupNameDraft(event.target.value)}
                        disabled={!selectedConversation.currentUserAdmin || isConversationActionLoading}
                        className="min-w-0 flex-1 rounded-xl border-2 border-transparent bg-surface-container-lowest px-4 py-2.5 text-sm font-bold text-on-surface outline-none focus:border-primary disabled:opacity-60"
                      />
                      {selectedConversation.currentUserAdmin && (
                        <button type="button" onClick={handleRenameGroup} disabled={isConversationActionLoading || !groupNameDraft.trim()} className="rounded-full bg-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
                          Save
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {selectedConversation.type === 'GROUP' && selectedConversation.currentUserAdmin && (
                  <div className="rounded-2xl bg-surface-container-low p-4">
                    <label className="mb-2 block text-xs font-bold uppercase tracking-wide text-on-surface-variant">Add members</label>
                    <div className="relative">
                      <input
                        value={addMemberQuery}
                        onChange={(event) => setAddMemberQuery(event.target.value)}
                        placeholder="Search people to add..."
                        className="w-full rounded-xl border-2 border-transparent bg-surface-container-lowest px-4 py-2.5 pl-10 text-sm font-semibold text-on-surface outline-none focus:border-primary"
                      />
                      <Search size={17} className="absolute left-3.5 top-3 text-outline-variant" />
                    </div>

                    {addMemberQuery.trim().length >= 2 && (
                      <div className="mt-2 max-h-52 overflow-y-auto rounded-xl border border-outline-variant/10 bg-surface-container-high">
                        {isAddMemberSearching ? (
                          <div className="flex justify-center p-4">
                            <Loader2 className="animate-spin text-primary" size={20} />
                          </div>
                        ) : addMemberResults.length > 0 ? (
                          addMemberResults.map(result => (
                            <button
                              key={result.id}
                              type="button"
                              onClick={() => handleAddGroupParticipant(result)}
                              disabled={isConversationActionLoading}
                              className="flex w-full items-center gap-3 border-b border-outline-variant/5 p-3 text-left transition-colors last:border-0 hover:bg-primary-container/20 disabled:opacity-60"
                            >
                              <img
                                src={result.avatarUrl || `https://ui-avatars.com/api/?name=${result.username}&background=random`}
                                alt={result.displayName || result.username}
                                className="h-9 w-9 shrink-0 rounded-full object-cover"
                                referrerPolicy="no-referrer"
                              />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-bold text-on-surface">{result.displayName || result.username}</p>
                                <p className="truncate text-xs font-semibold text-on-surface-variant">@{result.username}</p>
                              </div>
                              <UserPlus size={17} className="shrink-0 text-primary" />
                            </button>
                          ))
                        ) : (
                          <div className="p-4 text-center text-sm font-semibold text-on-surface-variant">No users found</div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div>
                  <h4 className="mb-3 text-sm font-bold uppercase tracking-wide text-on-surface-variant">Members</h4>
                  <div className="space-y-2">
                    {selectedConversation.participants.map(participant => {
                      const isSelf = participant.userId === user?.id;
                      const isAdmin = Boolean(participant.admin);
                      return (
                        <div key={participant.userId} className="rounded-2xl bg-surface-container-low p-3">
                          <div className="flex items-center gap-3">
                            <img src={participant.avatarUrl || `https://ui-avatars.com/api/?name=${participant.username || 'User'}`} alt={participantName(participant)} className="h-10 w-10 rounded-full object-cover" referrerPolicy="no-referrer" />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <p className="truncate text-sm font-bold text-on-surface">{participantName(participant)}</p>
                                {isAdmin && <span className="inline-flex items-center gap-1 rounded-full bg-primary-container px-2 py-0.5 text-[10px] font-bold text-primary"><Shield size={12} /> Admin</span>}
                                {isSelf && <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-[10px] font-bold text-on-surface-variant">You</span>}
                              </div>
                              <p className="truncate text-xs font-semibold text-on-surface-variant">@{participant.username || participant.userId}</p>
                            </div>
                          </div>
                          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                            <input
                              value={nicknameDrafts[participant.userId] ?? ''}
                              onChange={(event) => setNicknameDrafts(prev => ({ ...prev, [participant.userId]: event.target.value }))}
                              placeholder="Set nickname"
                              className="min-w-0 flex-1 rounded-xl bg-surface-container-lowest px-3 py-2 text-sm font-semibold text-on-surface outline-none focus:ring-2 focus:ring-primary-container"
                            />
                            <button type="button" onClick={() => handleSaveNickname(participant.userId)} disabled={isConversationActionLoading} className="rounded-full bg-surface-container-high px-4 py-2 text-xs font-bold text-on-surface hover:bg-surface-container-highest disabled:opacity-50">
                              Save nickname
                            </button>
                            {selectedConversation.type === 'GROUP' && selectedConversation.currentUserAdmin && !isSelf && !isAdmin && (
                              <button type="button" onClick={() => handleMakeAdmin(participant.userId)} disabled={isConversationActionLoading} className="inline-flex items-center justify-center gap-1 rounded-full bg-tertiary-container px-4 py-2 text-xs font-bold text-on-tertiary-container disabled:opacity-50">
                                <Shield size={14} /> Make admin
                              </button>
                            )}
                            {selectedConversation.type === 'GROUP' && selectedConversation.currentUserAdmin && !isSelf && (
                              <button type="button" onClick={() => handleKickParticipant(participant.userId)} disabled={isConversationActionLoading} className="inline-flex items-center justify-center gap-1 rounded-full bg-error-container px-4 py-2 text-xs font-bold text-on-error-container disabled:opacity-50">
                                <UserMinus size={14} /> Kick
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {selectedConversation.type === 'GROUP' && (
                <div className="flex flex-wrap justify-end gap-3 border-t border-outline-variant/10 px-6 py-4">
                  <button type="button" onClick={handleLeaveGroup} disabled={isConversationActionLoading} className="inline-flex items-center gap-2 rounded-full bg-surface-container-high px-5 py-2.5 text-sm font-bold text-on-surface disabled:opacity-50">
                    <LogOut size={16} /> Leave group
                  </button>
                  {selectedConversation.currentUserAdmin && (
                    <button type="button" onClick={handleDeleteGroup} disabled={isConversationActionLoading} className="inline-flex items-center gap-2 rounded-full bg-error px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50">
                      <Trash2 size={16} /> Delete group
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {previewMedia && (
          <div
            className="fixed inset-0 z-[110] flex items-center justify-center bg-black/95 p-4 backdrop-blur-sm"
            onClick={() => setPreviewMedia(null)}
          >
            <div className="absolute right-6 top-6 z-10 flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
              <button
                type="button"
                onClick={() => void handleDownloadAttachment(previewMedia.url, previewMedia.name || 'media')}
                className="flex h-11 w-11 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                title="Download"
                aria-label="Download media"
              >
                <Download size={23} />
              </button>
              <button
                type="button"
                onClick={() => setPreviewMedia(null)}
                className="flex h-11 w-11 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                aria-label="Close preview"
              >
                <X size={26} />
              </button>
            </div>
            <div className="flex max-h-[90vh] max-w-[92vw] items-center justify-center" onClick={(event) => event.stopPropagation()}>
              {previewMedia.type === 'VIDEO' ? (
                <video src={previewMedia.url} controls autoPlay className="max-h-[90vh] max-w-full object-contain" />
              ) : (
                <img src={previewMedia.url} alt={previewMedia.name || 'Preview media'} className="max-h-[90vh] max-w-full object-contain shadow-2xl" referrerPolicy="no-referrer" />
              )}
            </div>
          </div>
        )}
      <ConfirmDialog
        isOpen={destructiveConfirm.isOpen}
        title={destructiveConfirm.action === 'deleteGroup' ? 'Delete group?' : 'Remove member?'}
        message={destructiveConfirm.action === 'deleteGroup'
          ? 'Are you sure you want to delete this group? This action cannot be undone.'
          : `Are you sure you want to remove ${destructiveConfirm.participantName || 'this member'} from this group?`}
        confirmLabel={destructiveConfirm.action === 'deleteGroup' ? 'Delete group' : 'Remove'}
        cancelLabel="Cancel"
        type="danger"
        onConfirm={confirmDestructiveAction}
        onCancel={() => setDestructiveConfirm({ isOpen: false, action: null })}
      />
      <ConfirmDialog
        isOpen={leaveGroupConfirmOpen}
        title="Leave group?"
        message="Are you sure you want to leave this group? You will no longer see new messages from this conversation."
        confirmLabel="Leave group"
        cancelLabel="Cancel"
        type="danger"
        onConfirm={confirmLeaveGroup}
        onCancel={() => setLeaveGroupConfirmOpen(false)}
      />
      <ConfirmDialog
        isOpen={blockWarningDialog.isOpen}
        title="Blocked user in this group"
        message={`This group includes blocked user(s): ${blockWarningDialog.names.join(', ')}. You can continue chatting after acknowledging this notice.`}
        confirmLabel="Continue"
        cancelLabel="Close"
        type="warning"
        onConfirm={() => setBlockWarningDialog({ isOpen: false, names: [] })}
        onCancel={() => setBlockWarningDialog({ isOpen: false, names: [] })}
      />
      {directChatNotice && (
        <div
          role="alert"
          aria-live="assertive"
          className="fixed bottom-24 left-4 right-4 z-[100] overflow-hidden rounded-2xl border border-error/20 bg-error-container text-on-error-container shadow-xl sm:bottom-auto sm:left-auto sm:right-6 sm:top-6 sm:w-full sm:max-w-md"
        >
          <div className="flex items-start gap-3 px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold">Unable to start conversation</p>
              <p className="mt-0.5 text-sm">{directChatNotice}</p>
            </div>
            <span className="mt-0.5 shrink-0 text-xs font-bold tabular-nums" aria-label={`Closing in ${directChatNoticeSeconds} seconds`}>
              {directChatNoticeSeconds}s
            </span>
            <button
              type="button"
              onClick={() => setDirectChatNotice('')}
              className="shrink-0 rounded-full p-1 hover:bg-error/10"
              aria-label="Dismiss notification"
            >
              <X size={18} />
            </button>
          </div>
          <div className="h-1 bg-error/15">
            <div
              className="h-full bg-error transition-[width] duration-1000 ease-linear"
              style={{ width: `${(directChatNoticeSeconds / 5) * 100}%` }}
            />
          </div>
        </div>
      )}
      <ConfirmDialog
        isOpen={errorDialog.isOpen}
        title="Attention"
        message={errorDialog.message}
        confirmLabel="OK"
        cancelLabel="Close"
        type="warning"
        onConfirm={() => setErrorDialog({ ...errorDialog, isOpen: false })}
        onCancel={() => setErrorDialog({ ...errorDialog, isOpen: false })}
      />
    </Layout>
  );
}
