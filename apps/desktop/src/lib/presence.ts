import { useEffect, useRef, useState } from 'react';
import type { Session } from './session';
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

export function useTeamPresence(session: Session | null): PresenceSnapshot {
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
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    function scheduleReconnect() {
      if (disposed) return;
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
      let connection = readTeamConnection();
      if (!connection) {
        setStatus('offline');
        scheduleReconnect();
        return;
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
      socket = new WebSocket(`${wsBase}/v1/teams/${teamId}/presence`);

      socket.onopen = () => {
        socket?.send(JSON.stringify({ type: 'auth', token: connection.accessToken }));
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data)) as {
            type?: string;
            members?: PresenceMember[];
            message?: string;
          };
          if (data.type === 'presence' && Array.isArray(data.members)) {
            retryRef.current = 0;
            setMembers(data.members);
            setStatus('online');
          }
          if (data.type === 'error') {
            socket?.close();
          }
        } catch {
          // 忽略无法解析的消息。
        }
      };

      socket.onerror = () => {
        socket?.close();
      };

      socket.onclose = () => {
        if (disposed) return;
        setStatus('offline');
        setMembers([]);
        scheduleReconnect();
      };
    }

    void connect();

    const heartbeat = window.setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, HEARTBEAT_MS);

    return () => {
      disposed = true;
      window.clearInterval(heartbeat);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [session?.mode, session?.team?.id]);

  return { status, members };
}
