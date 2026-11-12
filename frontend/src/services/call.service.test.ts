import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callService } from './call.service';

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), defaults: { baseURL: 'http://localhost:8080/api' } }));
vi.mock('../config/api.config', () => ({ apiClient: client }));
beforeEach(() => vi.clearAllMocks());

describe('call API response contract', () => {
  it('reads an active call from the standard envelope and preserves a null active call', async () => {
    client.get.mockResolvedValueOnce({ data: { success: true, data: { id: 'call-1', status: 'RINGING' } } });
    expect(await callService.active()).toEqual({ id: 'call-1', status: 'RINGING' });
    client.get.mockResolvedValueOnce({ data: { success: true, data: null } });
    expect(await callService.active()).toBeNull();
  });

  it('unwraps valid video access while passing the cancellation signal', async () => {
    const access = { serverUrl: 'wss://test.livekit.cloud', participantToken: 'test-token', expiresAt: new Date(Date.now() + 120000).toISOString() };
    client.post.mockResolvedValueOnce({ data: { success: true, data: access } });
    const signal = new AbortController().signal;
    expect(await callService.access('call-1', signal)).toEqual(access);
    expect(client.post).toHaveBeenCalledWith('/calls/call-1/video-access', {}, { signal });
  });

  it('rejects incomplete access instead of opening a room with invalid credentials', async () => {
    client.post.mockResolvedValueOnce({ data: { success: true, data: { serverUrl: 'https://invalid.example' } } });
    await expect(callService.access('call-1', new AbortController().signal)).rejects.toThrow('invalid connection details');
  });
});
