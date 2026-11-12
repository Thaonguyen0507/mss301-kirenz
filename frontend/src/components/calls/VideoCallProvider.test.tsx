import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoCallProvider, useVideoCall } from './VideoCallProvider';
import { useAuthStore } from '../../store/authStore';
import type { VideoCall } from '../../types/call';
import type { Conversation } from '../../types/chat';

const mocks = vi.hoisted(() => ({
  start: vi.fn(), active: vi.fn(), get: vi.fn(), accept: vi.fn(), decline: vi.fn(), end: vi.fn(),
  heartbeat: vi.fn(), access: vi.fn(), endOnPageHide: vi.fn(),
  listeners: new Set<(call: VideoCall) => void>(),
}));
vi.mock('../../services/call.service', () => ({ callService: mocks }));
vi.mock('../../services/websocket.service', () => ({ websocketService: {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  subscribeToCalls: (callback: (call: VideoCall) => void) => {
    mocks.listeners.add(callback); return { unsubscribe: () => mocks.listeners.delete(callback) };
  },
} }));
vi.mock('./CallRoom', () => ({ default: ({ onEnd }: { onEnd: () => void }) => <div>Connected media<button onClick={onEnd}>Hang up media</button></div> }));

const invitation = (patch: Partial<VideoCall> = {}): VideoCall => ({
  id: 'call-1', conversationId: 'direct', caller: { userId: 'a', displayName: 'Alice' },
  callee: { userId: 'b', displayName: 'Ben' }, status: 'RINGING', createdAt: new Date().toISOString(),
  ringingExpiresAt: new Date(Date.now() + 60000).toISOString(), mediaClosed: false, revision: 1, ...patch,
});
const accepted = () => invitation({ status: 'ACCEPTED', acceptedAt: new Date().toISOString(), revision: 2 });
const ended = () => invitation({ status: 'ENDED', endReason: 'ENDED', mediaClosed: true, revision: 3 });
const access = { serverUrl: 'wss://test.livekit.cloud', participantToken: 'in-memory-test-token', expiresAt: new Date(Date.now() + 120000).toISOString() };
function Harness() {
  const { startCall } = useVideoCall();
  return <button onClick={() => void startCall({ id: 'direct', type: 'DIRECT' } as Conversation)}>Start from chat</button>;
}
function mount(userId = 'b') {
  useAuthStore.setState({ user: { id: userId } as never, isAuthenticated: true });
  localStorage.setItem('access_token', 'test-session');
  return render(<VideoCallProvider><p>Home feed</p><Harness /></VideoCallProvider>);
}
async function emit(call: VideoCall) { await act(async () => { mocks.listeners.forEach(listener => listener(call)); }); }
beforeEach(() => {
  vi.clearAllMocks(); mocks.listeners.clear();
  mocks.active.mockResolvedValue(null); mocks.access.mockResolvedValue(access);
  mocks.heartbeat.mockResolvedValue(accepted()); mocks.end.mockResolvedValue(ended());
});
afterEach(() => { cleanup(); localStorage.clear(); useAuthStore.setState({ user: null, isAuthenticated: false }); vi.useRealTimers(); });

describe('one-to-one call lifecycle', () => {
  it('rings on the home feed, accepts, joins, then hangs up and removes media', async () => {
    mocks.accept.mockResolvedValue(accepted()); mount(); await emit(invitation());
    expect(screen.getByText('Home feed')).toBeInTheDocument();
    expect(screen.getByText('Incoming video call')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept video call' }));
    await screen.findByText('Connected media');
    expect(mocks.accept).toHaveBeenCalledWith('call-1');
    fireEvent.click(screen.getByRole('button', { name: 'Hang up media' }));
    await screen.findByRole('dialog', { name: 'Call ended' });
    expect(screen.queryByText('Connected media')).not.toBeInTheDocument();
    expect(mocks.end).toHaveBeenCalledWith('call-1');
    expect(localStorage.getItem('participantToken')).toBeNull();
  });

  it('declines an invitation without acquiring media access', async () => {
    mocks.decline.mockResolvedValue(invitation({ status: 'ENDED', endReason: 'DECLINED', revision: 2, mediaClosed: true }));
    mount(); await emit(invitation());
    fireEvent.click(screen.getByRole('button', { name: 'Decline video call' }));
    await screen.findByRole('dialog', { name: 'Call declined' });
    expect(mocks.access).not.toHaveBeenCalled();
  });

  it('starts an outgoing call and joins the existing room when crossing invitations are accepted', async () => {
    mocks.start.mockResolvedValue(accepted()); mount('a');
    fireEvent.click(screen.getByRole('button', { name: 'Start from chat' }));
    await screen.findByText('Connected media');
    expect(mocks.start).toHaveBeenCalledWith('direct');
    expect(mocks.access).toHaveBeenCalledTimes(1);
  });

  it('aborts late token responses and ignores old ringing events after remote hangup', async () => {
    let deliver!: (value: typeof access) => void;
    mocks.access.mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
    mocks.start.mockResolvedValue(invitation()); mount('a');
    fireEvent.click(screen.getByRole('button', { name: 'Start from chat' }));
    await screen.findByText('Ringing…'); await emit(accepted());
    await waitFor(() => expect(mocks.access).toHaveBeenCalled());
    const signal = mocks.access.mock.calls[0][1] as AbortSignal;
    await emit(ended());
    await act(async () => { deliver(access); });
    expect(signal.aborted).toBe(true);
    await emit(invitation());
    expect(screen.queryByText('Connected media')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Call ended' })).toBeInTheDocument();
  });

  it('offers a retry after access fails, rather than leaving a connecting spinner', async () => {
    mocks.start.mockResolvedValue(accepted()); mocks.access.mockRejectedValueOnce(new Error('Provider offline'));
    mount('a'); fireEvent.click(screen.getByRole('button', { name: 'Start from chat' }));
    await screen.findByText('Provider offline');
    fireEvent.click(screen.getByRole('button', { name: 'Join call' }));
    await screen.findByText('Connected media');
  });

  it('does not take over media automatically when another tab accepted', async () => {
    mocks.active.mockResolvedValue(accepted()); mount();
    await screen.findByRole('button', { name: 'Join call' });
    expect(mocks.access).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Join call' }));
    await screen.findByText('Connected media');
  });

  it('retries failed hangup via REST reconciliation while keeping local media stopped', async () => {
    mocks.start.mockResolvedValue(accepted()); mount('a');
    fireEvent.click(screen.getByRole('button', { name: 'Start from chat' }));
    await screen.findByText('Connected media');
    mocks.end.mockRejectedValueOnce(new Error('Offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Hang up media' }));
    await screen.findByText('Could not confirm hang up. Retrying automatically when the connection returns.');
    expect(screen.queryByText('Connected media')).not.toBeInTheDocument();
    // A focus/visibility reconciliation uses the same recovery path as the periodic poll.
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await screen.findByRole('dialog', { name: 'Call ended' });
    expect(mocks.end).toHaveBeenCalledTimes(2);
  });
});
