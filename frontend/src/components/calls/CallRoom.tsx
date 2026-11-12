import { useEffect, useState } from 'react';
import { LiveKitRoom, RoomAudioRenderer, VideoTrack, useConnectionState, useLocalParticipant, useRemoteParticipants, useRoomContext, useStartAudio, useTracks } from '@livekit/components-react';
import { ConnectionState, DisconnectReason, RoomEvent, Track } from 'livekit-client';
import { Camera, CameraOff, Loader2, Mic, MicOff, PhoneOff, Volume2 } from 'lucide-react';
import type { CallAccess, CallPeer } from '../../types/call';
import { PeerAvatar } from './CallOverlay';

type Props = { access: CallAccess; peer: CallPeer; localPeer: CallPeer; acceptedAt: string; onEnd: () => void; onMediaError: () => void; onDisconnected?: () => void };
export default function CallRoom(props: Props) {
  return <LiveKitRoom serverUrl={props.access.serverUrl} token={props.access.participantToken} connect audio={false} video={false}
    options={{ adaptiveStream: true, dynacast: true }} onError={props.onMediaError}
    onDisconnected={reason => reason === DisconnectReason.DUPLICATE_IDENTITY ? props.onMediaError() : props.onDisconnected?.()}>
    <MediaControls {...props} />
  </LiveKitRoom>;
}

function MediaControls({ peer, localPeer, acceptedAt, onEnd }: Props) {
  const state = useConnectionState();
  const room = useRoomContext();
  const remote = useRemoteParticipants();
  const tracks = useTracks([Track.Source.Camera], { onlySubscribed: false });
  const { localParticipant, isCameraEnabled, isMicrophoneEnabled } = useLocalParticipant();
  const { canPlayAudio, mergedProps } = useStartAudio({ props: {} });
  const [deviceError, setDeviceError] = useState('');
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const localTrack = tracks.find(track => track.participant.isLocal && !track.publication.isMuted);
  const remoteTrack = tracks.find(track => !track.participant.isLocal && !track.publication.isMuted);

  useEffect(() => {
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - Date.parse(acceptedAt)) / 1000)));
    tick(); const timer = window.setInterval(tick, 1000); return () => window.clearInterval(timer);
  }, [acceptedAt]);

  useEffect(() => {
    let disposed = false;
    const enableDevices = async () => {
      // Separate requests let an unavailable camera fall back to a voice call.
      const results = await Promise.allSettled([localParticipant.setMicrophoneEnabled(true), localParticipant.setCameraEnabled(true)]);
      if (!disposed && results.some(result => result.status === 'rejected')) {
        setDeviceError('Could not open a device. Allow camera/microphone access in your browser, then try the controls below.');
      }
    };
    // Once per room, including when initially mounted in Connected state.
    if (room.state === ConnectionState.Connected) void enableDevices();
    else room.once(RoomEvent.Connected, enableDevices);
    return () => { disposed = true; room.off(RoomEvent.Connected, enableDevices); };
  }, [room, localParticipant]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const left = () => {
      // A short grace period avoids terminating on a transient peer network change.
      timer = setTimeout(() => { if (room.remoteParticipants.size === 0) onEnd(); }, 15000);
    };
    const returned = () => { if (timer) clearTimeout(timer); };
    room.on(RoomEvent.ParticipantDisconnected, left).on(RoomEvent.ParticipantConnected, returned);
    return () => { returned(); room.off(RoomEvent.ParticipantDisconnected, left).off(RoomEvent.ParticipantConnected, returned); };
  }, [room, onEnd]);

  async function toggle(kind: 'camera' | 'microphone') {
    if (busy || state !== ConnectionState.Connected) return;
    setBusy(true); setDeviceError('');
    try {
      if (kind === 'camera') await localParticipant.setCameraEnabled(!isCameraEnabled);
      else await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
    } catch { setDeviceError('Device unavailable. Check your browser permissions and device connection, then try again.'); }
    finally { setBusy(false); }
  }

  return <div className="call-room">
    <div className="call-video-stage">
      {remoteTrack ? <VideoTrack trackRef={remoteTrack} className="call-remote-video" />
        : <div className="call-remote-placeholder"><PeerAvatar peer={peer} /><h3>{peer.displayName}</h3>
          <p>{remote.length ? 'Camera is off' : 'Waiting for them to join…'}</p></div>}
      <div className="call-video-name">{peer.displayName}</div>
      <div className="call-local-preview">{localTrack ? <VideoTrack trackRef={localTrack} className="call-local-video" />
        : <div className="call-local-placeholder"><PeerAvatar peer={localPeer} /><CameraOff size={18} /></div>}
        <span>You{!isMicrophoneEnabled ? ' · Mic off' : ''}</span>
      </div>
      <div className="call-connection-badge" role="status">{state !== ConnectionState.Connected
        ? <><Loader2 size={14} className="call-spin" /> {state === ConnectionState.Reconnecting ? 'Reconnecting…' : 'Connecting…'}</>
        : `${Math.floor(elapsed / 60).toString().padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`}</div>
    </div>
    <RoomAudioRenderer />
    {!canPlayAudio && <button type="button" {...mergedProps} className="call-text-button"><Volume2 size={18} /> Enable call audio</button>}
    {deviceError && <p className="call-error" role="alert">{deviceError}</p>}
    <div className="call-controls">
      <div><button type="button" className={`call-round-button ${!isMicrophoneEnabled ? 'call-muted' : ''}`} disabled={busy || state !== ConnectionState.Connected}
        aria-pressed={isMicrophoneEnabled} aria-label={isMicrophoneEnabled ? 'Mute microphone' : 'Turn on microphone'} onClick={() => void toggle('microphone')}>
        {isMicrophoneEnabled ? <Mic size={23} /> : <MicOff size={23} />}</button><span>{isMicrophoneEnabled ? 'Mute' : 'Unmute'}</span></div>
      <div><button type="button" className={`call-round-button ${!isCameraEnabled ? 'call-muted' : ''}`} disabled={busy || state !== ConnectionState.Connected}
        aria-pressed={isCameraEnabled} aria-label={isCameraEnabled ? 'Turn off camera' : 'Turn on camera'} onClick={() => void toggle('camera')}>
        {isCameraEnabled ? <Camera size={23} /> : <CameraOff size={23} />}</button><span>Camera</span></div>
      <div><button type="button" className="call-round-button call-danger" aria-label="End call" onClick={onEnd}><PhoneOff size={25} /></button><span>End call</span></div>
    </div>
  </div>;
}
