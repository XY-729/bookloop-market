import { API_BASE_URL } from '../config';
import { token } from './api';
let socket: WechatMiniprogram.SocketTask | null = null;
let reconnect: ReturnType<typeof setTimeout> | null = null;
let retries = 0;
let active = false;
const listeners = new Set<(event: Record<string, any>) => void>();
function connect() {
  if (!active || !token()) return;
  socket = wx.connectSocket({
    url: API_BASE_URL.replace(/^http/, 'ws') + '/v1/ws',
    header: { Authorization: `Bearer ${token()}` },
  });
  socket.onOpen(() => {
    retries = 0;
    for (const f of listeners) f({ event: 'reconnected' });
  });
  socket.onMessage((r) => {
    try {
      const event = JSON.parse(String(r.data));
      for (const f of listeners) f(event);
    } catch {}
  });
  socket.onClose((r) => {
    socket = null;
    if (r.code === 1008) {
      active = false;
      return;
    }
    if (active) reconnect = setTimeout(connect, Math.min(30000, 1000 * 2 ** retries++));
  });
  socket.onError(() => {});
}
export function listen(handler: (event: Record<string, any>) => void) {
  listeners.add(handler);
  if (!active) {
    active = true;
    connect();
  }
  return () => {
    listeners.delete(handler);
    if (!listeners.size) {
      active = false;
      if (reconnect) clearTimeout(reconnect);
      reconnect = null;
      socket?.close({ code: 1000 });
      socket = null;
    }
  };
}
