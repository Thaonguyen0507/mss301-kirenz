import { Client, IMessage } from '@stomp/stompjs';
import SockJS from 'sockjs-client';
import { Attachment, ConversationUpdateMessage, Message } from '../types/chat';
import type { VideoCall } from '../types/call';

type SubscriptionHandle = { unsubscribe: () => void };
type PresenceUpdate = { userId: string, status: 'ONLINE' | 'OFFLINE', lastSeen?: number };

class WebSocketService {
  private client: Client | null = null;
  private userQueueSubscription: any = null;
  private presenceSubscription: any = null;
  private conversationSubscriptions: Map<string, any> = new Map();
  private conversationCallbacks: Map<string, (message: Message) => void> = new Map();
  private typingSubscriptions: Map<string, any> = new Map();
  private typingCallbacks: Map<string, Set<(data: { userId: string, isTyping: boolean }) => void>> = new Map();
  private connectionPromise: Promise<void> | null = null;
  private userQueueCallbacks: Set<(update: ConversationUpdateMessage) => void> = new Set();
  private presenceCallbacks: Set<(data: PresenceUpdate) => void> = new Set();
  private activeUserId: string | null = null;
  private callSubscription: SubscriptionHandle | null = null;
  private callCallbacks = new Set<(call: VideoCall) => void>();

  async connect(token: string, userId: string): Promise<void> {
    if (this.client?.connected && this.activeUserId === userId) return Promise.resolve();
    if (this.connectionPromise && this.activeUserId === userId) return this.connectionPromise;
    // An active client owns its reconnect loop. Reuse it rather than creating a second socket.
    if (this.client?.active && this.activeUserId === userId) return Promise.resolve();

    if (this.client && this.activeUserId !== userId) {
      this.disconnect();
    }

    this.activeUserId = userId;

    this.connectionPromise = new Promise((resolve, reject) => {
      this.client = new Client({
        webSocketFactory: () => new SockJS(import.meta.env.VITE_CHAT_WS_URL || `${import.meta.env.VITE_CHAT_API_URL || 'http://localhost:8080'}/ws/chat`),
        connectHeaders: {
          Authorization: `Bearer ${token}`,
        },
        debug: () => {}, // STOMP frames contain auth headers; never log them.
        reconnectDelay: 5000,
        heartbeatIncoming: 4000,
        heartbeatOutgoing: 4000,
      });

      this.client.onConnect = () => {
        console.log('Connected to WebSocket');
        this.restoreSubscriptions();
        resolve();
      };
      this.client.beforeConnect = () => {
        const freshToken = localStorage.getItem('access_token') || token;
        if (this.client) this.client.connectHeaders = { Authorization: `Bearer ${freshToken}` };
      };

      this.client.onStompError = (frame) => {
        console.error('STOMP error', frame);
        reject(frame);
      };

      this.client.onWebSocketClose = () => {
        console.log('WebSocket connection closed');
        this.connectionPromise = null;
        this.userQueueSubscription = null;
        this.presenceSubscription = null;
        this.callSubscription = null;
        this.conversationSubscriptions.clear();
        this.typingSubscriptions.clear();
      };

      this.client.activate();
    });

    return this.connectionPromise;
  }

  subscribeToCalls(callback: (call: VideoCall) => void): SubscriptionHandle {
    this.callCallbacks.add(callback);
    if (!this.callSubscription && this.client?.connected) this.subscribeCalls();
    return { unsubscribe: () => {
      this.callCallbacks.delete(callback);
      if (this.callCallbacks.size === 0) {
        this.callSubscription?.unsubscribe();
        this.callSubscription = null;
      }
    } };
  }

  private subscribeCalls() {
    this.callSubscription?.unsubscribe();
    this.callSubscription = this.client!.subscribe('/user/queue/calls', message => {
      const call: VideoCall = JSON.parse(message.body);
      this.callCallbacks.forEach(callback => callback(call));
    });
  }

  subscribeToUserQueue(userId: string, callback: (update: ConversationUpdateMessage) => void): SubscriptionHandle {
    this.userQueueCallbacks.add(callback);
    this.activeUserId = this.activeUserId || userId;

    if (!this.userQueueSubscription && this.client?.connected) {
      this.subscribeUserQueue();
    }

    return {
      unsubscribe: () => {
        this.userQueueCallbacks.delete(callback);
        if (this.userQueueCallbacks.size === 0 && this.userQueueSubscription) {
          this.userQueueSubscription.unsubscribe();
          this.userQueueSubscription = null;
        }
      }
    };
  }

  subscribeToConversation(conversationId: string, callback: (message: Message) => void): SubscriptionHandle {
    this.conversationCallbacks.set(conversationId, callback);

    if (this.client?.connected) {
      this.subscribeConversation(conversationId, callback);
    }

    return {
      unsubscribe: () => {
        this.unsubscribeFromConversation(conversationId);
      }
    };
  }

  subscribeToTyping(conversationId: string, callback: (data: { userId: string, isTyping: boolean }) => void): SubscriptionHandle {
    const callbacks = this.typingCallbacks.get(conversationId) || new Set();
    callbacks.add(callback);
    this.typingCallbacks.set(conversationId, callbacks);

    if (!this.typingSubscriptions.has(conversationId) && this.client?.connected) {
      this.subscribeTyping(conversationId);
    }

    return {
      unsubscribe: () => {
        const currentCallbacks = this.typingCallbacks.get(conversationId);
        currentCallbacks?.delete(callback);
        if (!currentCallbacks || currentCallbacks.size === 0) {
          this.typingCallbacks.delete(conversationId);
          this.typingSubscriptions.get(conversationId)?.unsubscribe();
          this.typingSubscriptions.delete(conversationId);
        }
      }
    };
  }

  subscribeToPresence(callback: (data: PresenceUpdate) => void): SubscriptionHandle {
    this.presenceCallbacks.add(callback);

    if (!this.presenceSubscription && this.client?.connected) {
      this.subscribePresence();
    }

    return {
      unsubscribe: () => {
        this.presenceCallbacks.delete(callback);
        if (this.presenceCallbacks.size === 0 && this.presenceSubscription) {
          this.presenceSubscription.unsubscribe();
          this.presenceSubscription = null;
        }
      }
    };
  }

  unsubscribeFromConversation(conversationId: string) {
    this.conversationSubscriptions.get(conversationId)?.unsubscribe();
    this.conversationSubscriptions.delete(conversationId);
    this.conversationCallbacks.delete(conversationId);
  }

  sendMessage(conversationId: string, content: string, attachments: Attachment[] = []) {
    if (!this.client?.connected) return;

    this.client.publish({
      destination: '/app/chat.send',
      body: JSON.stringify({
        conversationId,
        content,
        attachments,
      }),
    });
  }

  sendTyping(conversationId: string, isTyping: boolean) {
    if (!this.client?.connected) return;

    this.client.publish({
      destination: '/app/chat.typing',
      body: JSON.stringify({
        conversationId,
        isTyping,
      }),
    });
  }

  disconnect() {
    this.callSubscription?.unsubscribe();
    this.callSubscription = null;
    this.callCallbacks.clear();
    this.userQueueSubscription?.unsubscribe();
    this.userQueueSubscription = null;
    this.presenceSubscription?.unsubscribe();
    this.presenceSubscription = null;
    this.conversationSubscriptions.forEach((sub) => sub.unsubscribe());
    this.conversationSubscriptions.clear();
    this.conversationCallbacks.clear();
    this.typingSubscriptions.forEach((sub) => sub.unsubscribe());
    this.typingSubscriptions.clear();
    this.typingCallbacks.clear();
    this.userQueueCallbacks.clear();
    this.presenceCallbacks.clear();
    this.client?.deactivate();
    this.client = null;
    this.connectionPromise = null;
    this.activeUserId = null;
  }

  private restoreSubscriptions() {
    if (this.callCallbacks.size > 0) this.subscribeCalls();
    if (this.userQueueCallbacks.size > 0) {
      this.subscribeUserQueue();
    }
    if (this.presenceCallbacks.size > 0) {
      this.subscribePresence();
    }
    this.conversationCallbacks.forEach((callback, conversationId) => {
      this.subscribeConversation(conversationId, callback);
    });
    this.typingCallbacks.forEach((_, conversationId) => {
      this.subscribeTyping(conversationId);
    });
  }

  private subscribeUserQueue() {
    this.userQueueSubscription?.unsubscribe();
    this.userQueueSubscription = this.client!.subscribe(
      '/user/queue/messages',
      (message: IMessage) => {
        const parsed = JSON.parse(message.body);
        this.userQueueCallbacks.forEach(cb => cb(parsed));
      }
    );
  }

  private subscribePresence() {
    this.presenceSubscription?.unsubscribe();
    this.presenceSubscription = this.client!.subscribe(
      '/topic/presence',
      (message: IMessage) => {
        const parsed = JSON.parse(message.body);
        this.presenceCallbacks.forEach(cb => cb(parsed));
      }
    );
  }

  private subscribeConversation(conversationId: string, callback: (message: Message) => void) {
    this.conversationSubscriptions.get(conversationId)?.unsubscribe();
    const subscription = this.client!.subscribe(
      `/topic/conversation.${conversationId}`,
      (message: IMessage) => {
        callback(JSON.parse(message.body));
      }
    );
    this.conversationSubscriptions.set(conversationId, subscription);
  }

  private subscribeTyping(conversationId: string) {
    this.typingSubscriptions.get(conversationId)?.unsubscribe();
    const subscription = this.client!.subscribe(
      `/topic/conversation.${conversationId}.typing`,
      (message: IMessage) => {
        const parsed = JSON.parse(message.body);
        this.typingCallbacks.get(conversationId)?.forEach(cb => cb(parsed));
      }
    );
    this.typingSubscriptions.set(conversationId, subscription);
  }
}

export const websocketService = new WebSocketService();
