import { useEffect, useRef, useState } from 'react';
import type { NetworkMode } from '../data/types';
import type { Session } from './session';
import { checkNetworkAccessResolved } from './networkPolicy';
import { openWebSocket, type WebSocketHandle } from './protocol';
import { fetchTeams, readTeamConnection } from './teamClient';

export interface PresenceMember {
  userId: string;
  account: string;
  displayName: string;
  role: string;
  connections: number;
  connectedAt: string;
}

export type PresenceStatus = 'offline' | 'connecting' | 'online';

export interface PresenceSnapshot {
  status: PresenceStatus;
  members: PresenceMember[];
}

const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_MS = 25_000;

export function useTeamPresence(
  session: Session | null,
  networkMode: NetworkMode,
): PresenceSnapshot {
  const [status, setStatus] = useState<PresenceStatus>('offline');
  const [members, setMembers] = useState<PresenceMember[]>([]);
  const retryRef = useRef(0);

  useEffect(() => {
    retryRef.current = 0;
    setMembers([]);

    if (session?.mode !== 'team' || !session.team?.id) {
      setStatus('offline');
      return;
    }

    const teamId = session.team.id;
    let disposed = false;
    let socket: WebSocketHandle | null = null;
    let reconnectTimer: number | null = null;
    let opened = false;
    let online = false;
    let reconnecting = false;

    function scheduleReconnect() {
      if (disposed || reconnecting) return;
      reconnecting = true;
      retryRef.current += 1;
      const delay = Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_BASE_MS * 2 ** (retryRef.current - 1),
      );
      reconnectTimer = window.setTimeout(() => {
        void connect();
      }, delay);
    }

    async function connect() {
      if (disposed) return;
      reconnecting = false;
      let connection = readTeamConnection();
      if (!connection) {
        setStatus('offline');
        scheduleReconnect();
        return;
      }

      const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
      if (!isTauri) {
        const access = await checkNetworkAccessResolved(connection.serverUrl, networkMode);
        if (!access.allowed) {
          setStatus('offline');
          setMembers([]);
          return;
        }
      }

      // 先走一次普通请求，访问令牌过期时由 teamRequest 自动续期。
      try {
        await fetchTeams(connection);
        connection = readTeamConnection() ?? connection;
      } catch {
        // 网络不可用时继续用现有令牌尝试建立连接。
      }
      if (disposed) return;

      const wsBase = connection.serverUrl.replace(/^http/i, 'ws');
      setStatus('connecting');
      opened = false;
      online = false;
      const token = connection.accessToken;
      socket = openWebSocket(`${wsBase}/v1/teams/${teamId}/presence`, (event) => {
        if (disposed) return;
        if (event.kind === 'info') return;
        if (event.kind === 'open') {
          opened = true;
          socket?.send(JSON.stringify({ type: 'auth', token }));
          return;
        }
        if (event.kind === 'message') {
          try {
            const data = JSON.parse(event.payload) as {
              type?: string;
              members?: PresenceMember[];
            };
            if (data.type === 'presence' && Array.isArray(data.members)) {
              retryRef.current = 0;
              online = true;
              setMembers(data.members);
              setStatus('online');
            }
            if (data.type === 'error') {
              socket?.close();
            }
          } catch {
            // 忽略无法解析的消息。
          }
          return;
        }
        if (event.kind === 'error' || event.kind === 'close') {
          if (disposed) return;
          const shouldReconnect = opened || event.kind === 'error' || event.kind === 'close';
          opened = false;
          online = false;
          setStatus('offline');
          setMembers([]);
          if (shouldReconnect) {
            socket = null;
            scheduleReconnect();
          }
        }
      }, networkMode);
    }

    void connect();

    const heartbeat = window.setInterval(() => {
      if (!online) return;
      try {
        socket?.send(JSON.stringify({ type: 'ping' }));
      } catch {
        // 连接未就绪时忽略心跳。
      }
    }, HEARTBEAT_MS);

    return () => {
      disposed = true;
      window.clearInterval(heartbeat);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [session?.mode, session?.team?.id, networkMode]);

  return { status, members };
}
