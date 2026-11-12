import { apiClient } from '../config/api.config';
import type { CallAccess, VideoCall } from '../types/call';
import type { ApiResponse } from '../types/auth.types';

export const callService = {
  async start(conversationId: string) {
    return (await apiClient.post<ApiResponse<VideoCall>>('/calls', { conversationId })).data.data;
  },
  async active() {
    return (await apiClient.get<ApiResponse<VideoCall | null>>('/calls/active', { headers: { 'Cache-Control': 'no-cache' } })).data.data;
  },
  async get(id: string) { return (await apiClient.get<ApiResponse<VideoCall>>(`/calls/${id}`)).data.data; },
  async accept(id: string) { return (await apiClient.post<ApiResponse<VideoCall>>(`/calls/${id}/accept`)).data.data; },
  async decline(id: string) { return (await apiClient.post<ApiResponse<VideoCall>>(`/calls/${id}/decline`)).data.data; },
  async end(id: string) { return (await apiClient.post<ApiResponse<VideoCall>>(`/calls/${id}/end`)).data.data; },
  async heartbeat(id: string) { return (await apiClient.post<ApiResponse<VideoCall>>(`/calls/${id}/heartbeat`)).data.data; },
  async access(id: string, signal: AbortSignal): Promise<CallAccess> {
    const access = (await apiClient.post<ApiResponse<CallAccess>>(`/calls/${id}/video-access`, {}, { signal })).data.data;
    if (!access.serverUrl?.startsWith('wss://') || !access.participantToken || !Number.isFinite(Date.parse(access.expiresAt))) {
      throw new Error('The video server returned invalid connection details.');
    }
    return access;
  },
  // pagehide cannot await Axios; keepalive also covers closing/reloading the tab.
  endOnPageHide(id: string) {
    const token = localStorage.getItem('access_token');
    if (!token) return;
    void fetch(`${apiClient.defaults.baseURL}/calls/${id}/end`, {
      method: 'POST', keepalive: true, headers: { Authorization: `Bearer ${token}` },
    }).catch(() => { /* The server heartbeat timeout closes abandoned calls. */ });
  },
};
