import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Loader2, Phone, PhoneOff, Video, Volume2, X } from 'lucide-react';
import type { CallAccess, CallPeer, VideoCall } from '../../types/call';
import { useRingtone } from './useRingtone';
import './calls.css';

const CallRoom = lazy(() => import('./CallRoom'));
export function PeerAvatar({ peer, className = '' }: { peer: CallPeer; className?: string }) {
  const [failed, setFailed] = useState(false);
  return <div className={`call-avatar ${className}`}>
    {peer.avatarUrl && !failed
      ? <img src={peer.avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : <span>{(peer.displayName || 'K').slice(0, 1).toUpperCase()}</span>}
  </div>;
}

export type CallOverlayProps = {
  call: VideoCall; userId: string; access: CallAccess | null; joining: boolean; ending: boolean;
  busy: boolean; error: string; onAccept: () => void; onDecline: () => void; onEnd: () => void;
  onMediaError: () => void; onDisconnected: () => void; onJoin: () => void; onDismiss: () => void;
};

export function CallOverlay(props: CallOverlayProps) {
  const { call, userId, access, joining, ending, busy, error, onAccept, onDecline, onEnd, onMediaError, onJoin, onDismiss } = props;
  const incoming = call.callee.userId === userId;
  const peer = incoming ? call.caller : call.callee;
  const localPeer = incoming ? call.callee : call.caller;
  const ringing = call.status === 'RINGING';
  const ended = call.status === 'ENDED';
  const { soundBlocked, enableSound } = useRingtone(ringing, incoming);
  const [now, setNow] = useState(Date.now());
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = Math.max(0, Math.ceil((Date.parse(call.ringingExpiresAt) - now) / 1000));
  const endedLabel = call.endReason === 'MISSED' ? 'No answer' : call.endReason === 'DECLINED'
    ? 'Call declined' : call.endReason === 'CANCELLED' ? 'Call cancelled'
      : call.endReason === 'DISCONNECTED' ? 'Call disconnected' : 'Call ended';

  return <div className="call-backdrop">
    <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="call-title" className={`call-dialog ${access && !ended ? 'call-dialog-media' : ''}`}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href]') || []) as HTMLElement[];
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <div className="call-topline"><span className="call-brand"><Video size={18} /> KIRENZ CALLS</span>
        {ended && <button type="button" className="call-icon-button" aria-label="Close call" onClick={onDismiss}><X size={20} /></button>}
        {ringing && <span className="call-direction">{incoming ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}{incoming ? 'Incoming' : 'Outgoing'}</span>}
      </div>
      <h2 id="call-title" className="call-sr-only">{ended ? endedLabel : `Video call with ${peer.displayName}`}</h2>
      {access && !ended && !ending ? <Suspense fallback={<div className="call-loading"><Loader2 className="call-spin" /> Connecting video…</div>}>
        <CallRoom access={access} peer={peer} localPeer={localPeer} acceptedAt={call.acceptedAt!} onEnd={onEnd} onMediaError={onMediaError} onDisconnected={props.onDisconnected} />
      </Suspense> : <div className="call-lobby">
        <div className={ringing ? 'call-ringing-avatar' : ''}><PeerAvatar peer={peer} /></div>
        <h3>{peer.displayName || 'Kirenz user'}</h3>
        <p role="status" aria-live="polite" className="call-status">{ending ? 'Ending call…' : ended ? endedLabel
          : ringing ? incoming ? 'Incoming video call' : remaining ? 'Ringing…' : 'Waiting for an answer…'
            : joining ? 'Connecting your video…' : 'A video call is in progress'}</p>
        <p className="call-hint">{ringing ? incoming ? 'A face-to-face moment, wherever you are.' : 'Waiting for them to pick up.'
          : ended ? 'You can continue the conversation in chat.' : 'Camera and microphone turn on when you join.'}</p>
        {ringing && <span className="call-countdown">{remaining}s</span>}
        {soundBlocked && ringing && <button type="button" className="call-text-button" onClick={enableSound}><Volume2 size={16} /> Enable ringtone</button>}
        <div className="call-actions">
          {ringing && incoming ? <>
            <div><button type="button" className="call-round-button call-danger" disabled={busy} aria-label="Decline video call" onClick={onDecline}><PhoneOff size={26} /></button><span>Decline</span></div>
            <div><button type="button" className="call-round-button call-answer" disabled={busy} aria-label="Accept video call" onClick={onAccept}>{busy ? <Loader2 className="call-spin" /> : <Video size={28} />}</button><span>Accept</span></div>
          </> : ended ? <button type="button" className="call-pill-button" onClick={onDismiss}>Back to chat</button>
            : <>
              {call.status === 'ACCEPTED' && !joining && !ending && <button type="button" className="call-pill-button call-answer" onClick={onJoin}><Video size={20} /> Join call</button>}
              <div><button type="button" className="call-round-button call-danger" disabled={busy} aria-label={ringing ? 'Cancel video call' : 'End call'} onClick={onEnd}><PhoneOff size={26} /></button><span>{ringing ? 'Cancel' : 'End call'}</span></div>
            </>}
        </div>
        {ended && !call.mediaClosed && <p className="call-hint" role="status">Media shutdown is still being confirmed. Retrying automatically.</p>}
      </div>}
      {error && <p className="call-error" role="alert">{error}</p>}
      <div className="call-footer"><Phone size={12} /> Private one-to-one call</div>
    </section>
  </div>;
}
