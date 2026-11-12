import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { useAuthStore } from '../../store/authStore';
import { websocketService } from '../../services/websocket.service';
import { callService } from '../../services/call.service';
import type { Conversation } from '../../types/chat';
import type { CallAccess, VideoCall } from '../../types/call';
import { CallOverlay } from './CallOverlay';

type CallContextValue = {
  call: VideoCall | null;
  busy: boolean;
  startCall: (conversation: Conversation) => Promise<void>;
};
const CallContext = createContext<CallContextValue | null>(null);
export function useVideoCall() {
  const context = useContext(CallContext);
  if (!context) throw new Error('useVideoCall requires VideoCallProvider');
  return context;
}
const errorMessage = (error: unknown) => isAxiosError(error)
  ? error.response?.data?.message || 'The call could not connect. Please try again.'
  : error instanceof Error ? error.message : 'The call could not connect. Please try again.';

export function VideoCallProvider({ children }: { children: React.ReactNode }) {
  const userId = useAuthStore(state => state.user?.id);
  const [call, setCall] = useState<VideoCall | null>(null);
  const callRef = useRef<VideoCall | null>(null);
  const revisions = useRef(new Map<string, number>());
  const [access, setAccess] = useState<CallAccess | null>(null);
  const [joinId, setJoinId] = useState<string | null>(null);
  const joinRef = useRef<string | null>(null);
  const [endingId, setEndingId] = useState<string | null>(null);
  const endingRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const actionBusy = useRef(false);
  const [error, setError] = useState('');

  const apply = useCallback((incoming: VideoCall) => {
    const revision = revisions.current.get(incoming.id) ?? -1;
    if (incoming.revision < revision) return;
    revisions.current.set(incoming.id, incoming.revision);
    if (revisions.current.size > 50) revisions.current.delete(revisions.current.keys().next().value!);
    const current = callRef.current;
    if (current && current.id !== incoming.id && Date.parse(current.createdAt) > Date.parse(incoming.createdAt)) return;
    if (current?.id === incoming.id && current.status === 'ENDED' && incoming.status !== 'ENDED') return;
    callRef.current = incoming;
    setCall(incoming);
    if (incoming.status === 'ENDED') {
      setAccess(null);
      setJoinId(null);
      joinRef.current = null;
      setEndingId(null);
      endingRef.current = null;
    }
  }, []);

  // One provider lives above routes, so navigating away from chat does not miss incoming calls.
  useEffect(() => {
    if (!userId) { websocketService.disconnect(); return; }
    let disposed = false;
    let syncing = false;
    const token = localStorage.getItem('access_token');
    if (!token) return;
    const subscription = websocketService.subscribeToCalls(incoming => { if (!disposed) apply(incoming); });
    void websocketService.connect(token, userId).catch(() => { /* REST polling recovers missed signaling. */ });

    const sync = async () => {
      if (disposed || syncing) return;
      syncing = true;
      try {
        const current = callRef.current;
        if (endingRef.current) {
          const result = await callService.end(endingRef.current);
          if (!disposed) { apply(result); setError(''); }
        } else if (current?.status === 'ACCEPTED' && joinRef.current === current.id) {
          const result = await callService.heartbeat(current.id);
          if (!disposed) apply(result);
        } else {
          const active = await callService.active();
          if (disposed) return;
          if (active) apply(active);
          else if (current && (current.status !== 'ENDED' || !current.mediaClosed)) {
            const result = await callService.get(current.id);
            if (!disposed) apply(result);
          }
        }
      } catch { /* Keep the current state. Provider media reconnects; server expires an abandoned call. */ }
      finally { syncing = false; }
    };
    void sync();
    const interval = window.setInterval(() => void sync(), 5000);
    const onVisibility = () => { if (!document.hidden) void sync(); };
    const onPageHide = () => { if (joinRef.current) callService.endOnPageHide(joinRef.current); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      disposed = true;
      subscription.unsubscribe();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      if (joinRef.current) callService.endOnPageHide(joinRef.current);
      callRef.current = null;
      joinRef.current = null;
      endingRef.current = null;
      revisions.current.clear();
      setCall(null); setAccess(null); setJoinId(null); setEndingId(null); setError('');
    };
  }, [userId, apply]);

  useEffect(() => {
    if (!call || call.status !== 'ACCEPTED' || joinId !== call.id || endingId === call.id) return;
    const controller = new AbortController();
    let disposed = false;
    setError('');
    void callService.access(call.id, controller.signal).then(result => {
      if (!disposed && callRef.current?.status === 'ACCEPTED') setAccess(result);
    }).catch(err => {
      if (!disposed) { setError(errorMessage(err)); setAccess(null); joinRef.current = null; setJoinId(null); }
    });
    return () => { disposed = true; controller.abort(); setAccess(null); };
  }, [call?.id, call?.status, joinId, endingId]);

  const act = useCallback(async (action: () => Promise<void>) => {
    if (actionBusy.current) return;
    actionBusy.current = true;
    setBusy(true); setError('');
    try { await action(); } catch (err) { setError(errorMessage(err)); }
    finally { actionBusy.current = false; setBusy(false); }
  }, []);

  const startCall = useCallback(async (conversation: Conversation) => {
    if (!userId || conversation.type !== 'DIRECT') return;
    await act(async () => {
      if (callRef.current && callRef.current.status !== 'ENDED') return;
      const next = await callService.start(conversation.id);
      apply(next);
      if (callRef.current?.status !== 'ENDED') { joinRef.current = next.id; setJoinId(next.id); }
    });
  }, [userId, act, apply]);

  const accept = useCallback(() => act(async () => {
    const current = callRef.current;
    if (!current) return;
    joinRef.current = current.id;
    setJoinId(current.id);
    apply(await callService.accept(current.id));
  }), [act, apply]);

  const decline = useCallback(() => act(async () => {
    if (callRef.current) apply(await callService.decline(callRef.current.id));
  }), [act, apply]);

  const end = useCallback(() => act(async () => {
    const current = callRef.current;
    if (!current || current.status === 'ENDED') return;
    endingRef.current = current.id; setEndingId(current.id); setAccess(null);
    try { apply(await callService.end(current.id)); }
    catch { setError('Could not confirm hang up. Retrying automatically when the connection returns.'); }
  }), [act, apply]);

  const mediaError = useCallback(() => {
    if (callRef.current?.status !== 'ACCEPTED' || endingRef.current) return;
    setError('Video connection failed. Check your network and try joining again, or end the call.');
    setAccess(null);
    joinRef.current = null;
    setJoinId(null);
  }, []);

  const mediaDisconnected = useCallback(() => {
    // Ignore the disconnect caused by unmounting after hangup, an error or a device takeover.
    const current = callRef.current;
    if (current?.status === 'ACCEPTED' && joinRef.current === current.id && !endingRef.current) void end();
  }, [end]);

  const join = useCallback(() => {
    const current = callRef.current;
    if (!current || current.status !== 'ACCEPTED') return;
    setError(''); joinRef.current = current.id; setJoinId(current.id);
  }, []);

  return <CallContext.Provider value={{ call, busy, startCall }}>
    {children}
    {userId && call && <CallOverlay call={call} userId={userId} access={access} joining={joinId === call.id}
      ending={endingId === call.id} busy={busy} error={error} onAccept={accept}
      onDecline={decline} onEnd={end} onMediaError={mediaError} onDisconnected={mediaDisconnected}
      onJoin={join} onDismiss={() => { callRef.current = null; setCall(null); setError(''); }} />}
    {error && !call && <div className="fixed bottom-6 left-4 right-4 z-[160] mx-auto max-w-md rounded-2xl bg-error-container p-4 text-on-error-container shadow-xl" role="alert">
      <p>{error}</p><button type="button" className="mt-2 font-bold underline" onClick={() => setError('')}>Dismiss</button>
    </div>}
  </CallContext.Provider>;
}
