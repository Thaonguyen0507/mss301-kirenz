export type CallPeer = { userId: string; displayName: string; avatarUrl?: string | null };
export type VideoCall = {
  id: string;
  conversationId: string;
  caller: CallPeer;
  callee: CallPeer;
  status: 'RINGING' | 'ACCEPTED' | 'ENDED';
  endReason?: 'ENDED' | 'CANCELLED' | 'DECLINED' | 'MISSED' | 'DISCONNECTED' | null;
  createdAt: string;
  ringingExpiresAt: string;
  acceptedAt?: string | null;
  endedAt?: string | null;
  mediaClosed: boolean;
  revision: number;
};
export type CallAccess = { serverUrl: string; participantToken: string; expiresAt: string };
