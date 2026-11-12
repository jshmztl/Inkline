import { kvGet, kvRemove, kvSet } from './kv';

export interface TeamConnectionUser {
  id: string;
  account: string;
  displayName: string;
}

export interface TeamConnection {
  serverUrl: string;
  accessToken: string;
  refreshToken: string;
  user: TeamConnectionUser;
}

export interface RemoteTeam {
  id: string;
  name: string;
  role: string;
  revision: number;
  memberCount: number;
  maxDataLevel: string;
  snapshotRetentionDays?: number;
  auditRetentionDays?: number;
}

export interface TeamAccess {
  role: string;
  canPush: boolean;
  canManageMembers: boolean;
  canManagePermissions: boolean;
  collections: Record<string, 'edit' | 'view'>;
  requests: Record<string, 'edit' | 'view'>;
}

const CONNECTION_KEY = 'aw-team-connection';
const SERVER_HINT_KEY = 'aw-team-server-hint';

export class TeamApiError extends Error {
  status: number;
  code: string;
  details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'TeamApiError';
    this.status = status;
    this.code = code;
    this.details = details ?? null;
  }
}

export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new TeamApiError(0, 'invalid_server', '请输入团队服务地址');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    throw new TeamApiError(0, 'invalid_server', '团队服务地址格式不正确');
  }
}

export function readTeamConnection(): TeamConnection | null {
  try {
    const raw = kvGet(CONNECTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TeamConnection>;
    if (!parsed?.serverUrl || !parsed?.accessToken || !parsed?.refreshToken || !parsed?.user) {
      return null;
    }
    return parsed as TeamConnection;
  } catch {
    return null;
  }
}

export function saveTeamConnection(connection: TeamConnection) {
  kvSet(CONNECTION_KEY, JSON.stringify(connection));
  kvSet(SERVER_HINT_KEY, connection.serverUrl);
}

export function clearTeamConnection() {
  kvRemove(CONNECTION_KEY);
}

export function readServerHint(): string {
  return kvGet(SERVER_HINT_KEY) ?? '';
}

function rememberServer(url: string) {
  kvSet(SERVER_HINT_KEY, url);
}

async function parseResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorFromResponse(status: number, data: unknown): TeamApiError {
  const payload = data as
    | { error?: { code?: string; message?: string; details?: unknown } }
    | null;
  const code = payload?.error?.code ?? 'request_failed';
  const message =
    payload?.error?.message ??
    (status === 0 ? '无法连接团队服务，请检查地址与网络' : `团队服务请求失败（${status}）`);
  return new TeamApiError(status, code, message, payload?.error?.details);
}

async function publicRequest(
  serverUrl: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${serverUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new TeamApiError(0, 'network_error', '无法连接团队服务，请检查地址与网络');
  }
  const data = await parseResponse(response);
  if (!response.ok) throw errorFromResponse(response.status, data);
  return data;
}

async function refreshConnection(connection: TeamConnection): Promise<void> {
  let data: { accessToken?: string; refreshToken?: string } | null;
  try {
    data = (await publicRequest(connection.serverUrl, '/v1/auth/refresh', {
      refreshToken: connection.refreshToken,
    })) as { accessToken?: string; refreshToken?: string } | null;
  } catch {
    clearTeamConnection();
    throw new TeamApiError(401, 'session_expired', '登录已过期，请重新连接团队服务');
  }
  if (!data?.accessToken || !data?.refreshToken) {
    clearTeamConnection();
    throw new TeamApiError(401, 'session_expired', '登录已过期，请重新连接团队服务');
  }
  connection.accessToken = data.accessToken;
  connection.refreshToken = data.refreshToken;
  saveTeamConnection(connection);
}

export async function teamRequest(
  connection: TeamConnection,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  retry = true,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${connection.accessToken}`,
    ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers ?? {}),
  };

  let response: Response;
  try {
    response = await fetch(`${connection.serverUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new TeamApiError(0, 'network_error', '无法连接团队服务，请检查地址与网络');
  }

  if (response.status === 401 && retry) {
    await refreshConnection(connection);
    return teamRequest(connection, path, init, false);
  }

  const data = await parseResponse(response);
  if (!response.ok) throw errorFromResponse(response.status, data);
  return data;
}

export async function loginTeam(
  serverUrl: string,
  account: string,
  password: string,
): Promise<{ connection: TeamConnection; teams: RemoteTeam[] }> {
  const url = normalizeServerUrl(serverUrl);
  const login = (await publicRequest(url, '/v1/auth/login', {
    account: account.trim(),
    password,
  })) as {
    accessToken?: string;
    refreshToken?: string;
    user?: TeamConnectionUser;
  } | null;

  if (!login?.accessToken || !login.refreshToken || !login.user) {
    throw new TeamApiError(0, 'invalid_response', '团队服务返回了无法识别的登录结果');
  }

  const connection: TeamConnection = {
    serverUrl: url,
    accessToken: login.accessToken,
    refreshToken: login.refreshToken,
    user: login.user,
  };

  try {
    const me = (await teamRequest(connection, '/v1/me')) as { teams?: RemoteTeam[] };
    rememberServer(url);
    saveTeamConnection(connection);
    return { connection, teams: me.teams ?? [] };
  } catch (error) {
    clearTeamConnection();
    throw error;
  }
}

export async function fetchTeams(connection: TeamConnection): Promise<RemoteTeam[]> {
  const me = (await teamRequest(connection, '/v1/me')) as { teams?: RemoteTeam[] };
  return me.teams ?? [];
}

export async function createTeamRemote(
  connection: TeamConnection,
  name: string,
): Promise<RemoteTeam> {
  const result = (await teamRequest(connection, '/v1/teams', {
    method: 'POST',
    body: { name },
  })) as { team?: RemoteTeam } | null;
  if (!result?.team) throw new TeamApiError(0, 'invalid_response', '创建团队失败');
  return result.team;
}

export async function fetchTeamAccess(
  connection: TeamConnection,
  teamId: string,
): Promise<TeamAccess> {
  return (await teamRequest(connection, `/v1/teams/${teamId}/access`)) as TeamAccess;
}

export async function pushSnapshotRemote(
  connection: TeamConnection,
  teamId: string,
  payload: unknown,
  baseRevision: number,
): Promise<{ revision: number; hash: string; createdAt: string }> {
  return (await teamRequest(connection, `/v1/teams/${teamId}/snapshots`, {
    method: 'POST',
    body: payload,
    headers: {
      'X-Inkline-Base-Revision': String(baseRevision),
      'Idempotency-Key': crypto.randomUUID(),
    },
  })) as { revision: number; hash: string; createdAt: string };
}

export async function fetchLatestSnapshot(
  connection: TeamConnection,
  teamId: string,
): Promise<{ revision: number; payload: Record<string, unknown>; createdAt: string; createdBy?: { displayName?: string } } | null> {
  const meta = (await teamRequest(connection, `/v1/teams/${teamId}/snapshots/latest`)) as
    | {
        revision: number;
        downloadUrl: string;
        createdAt: string;
        createdBy?: { displayName?: string };
      }
    | null;
  if (!meta) return null;
  const payload = (await teamRequest(connection, meta.downloadUrl)) as Record<string, unknown>;
  return { ...meta, payload };
}

export async function logoutTeam(connection: TeamConnection | null): Promise<void> {
  if (connection) {
    try {
      await publicRequest(connection.serverUrl, '/v1/auth/logout', {
        refreshToken: connection.refreshToken,
      });
    } catch {
      // 登出失败不阻断本地清理。
    }
  }
  clearTeamConnection();
}
