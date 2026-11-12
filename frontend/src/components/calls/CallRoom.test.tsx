import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CallRoom from './CallRoom';

const media = vi.hoisted(() => ({
  microphone: vi.fn(), camera: vi.fn(), end: vi.fn(),
  room: { state: 'connected', remoteParticipants: new Map(), once: vi.fn(), on: vi.fn(), off: vi.fn() },
}));
vi.mock('@livekit/components-react', () => ({
  LiveKitRoom: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  RoomAudioRenderer: () => <div data-testid="remote-audio" />,
  VideoTrack: () => <video />,
  useConnectionState: () => 'connected', useRoomContext: () => media.room,
  useRemoteParticipants: () => [], useTracks: () => [],
  useLocalParticipant: () => ({ localParticipant: { setMicrophoneEnabled: media.microphone, setCameraEnabled: media.camera }, isCameraEnabled: true, isMicrophoneEnabled: true }),
  useStartAudio: () => ({ canPlayAudio: false, mergedProps: {} }),
}));

beforeEach(() => {
  vi.clearAllMocks(); media.microphone.mockResolvedValue(undefined); media.camera.mockResolvedValue(undefined);
  media.room.on.mockReturnValue(media.room); media.room.off.mockReturnValue(media.room);
});
afterEach(cleanup);
function mount() { render(<CallRoom access={{ serverUrl: 'wss://test', participantToken: 'test', expiresAt: '' }}
  peer={{ userId: 'b', displayName: 'Ben' }} localPeer={{ userId: 'a', displayName: 'Alice' }}
  acceptedAt={new Date().toISOString()} onEnd={media.end} onMediaError={vi.fn()} />); }

describe('call media controls', () => {
  it('requests devices, renders remote audio and provides camera/microphone/hangup controls', async () => {
    mount(); await waitFor(() => expect(media.microphone).toHaveBeenCalledWith(true));
    expect(media.camera).toHaveBeenCalledWith(true);
    expect(screen.getByTestId('remote-audio')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable call audio' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mute microphone' }));
    await waitFor(() => expect(media.microphone).toHaveBeenCalledWith(false));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Turn off camera' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Turn off camera' }));
    await waitFor(() => expect(media.camera).toHaveBeenCalledWith(false));
    fireEvent.click(screen.getByRole('button', { name: 'End call' })); expect(media.end).toHaveBeenCalledTimes(1);
  });

  it('keeps hangup and audio available when camera permission is denied', async () => {
    media.camera.mockRejectedValue(new Error('Permission denied')); mount();
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'End call' })).toBeEnabled();
    expect(screen.getByTestId('remote-audio')).toBeInTheDocument();
  });
});
