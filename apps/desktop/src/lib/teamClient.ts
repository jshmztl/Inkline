import { sendHttpRequest } from './api';
import { kvGet, kvRemove, kvSet } from './kv';
import { backendNetworkOptions, currentNetworkMode } from './network';
import { checkNetworkAccessResolved } from './networkPolicy';
import {
  CONNECTION_META_KEY,
  clearStoredTokens,
  persistTokens,
  readCachedTokens,
  setCachedTokens,
} from './teamSecrets';
import {
  decryptSnapshotPayload,
  encryptSnapshotPayload,
  isEncryptedPayload,
} from './teamCrypto';

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
    const raw = kvGet(CONNECTION_META_KEY);
    if (!raw) return null;
    const meta = JSON.parse(raw) as { serverUrl?: string; user?: TeamConnectionUser };
    const tokens = readCachedTokens();
    if (!meta?.serverUrl || !meta?.user || !tokens) return null;
    return {
      serverUrl: meta.serverUrl,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: meta.user,
    };
  } catch {
    return null;
  }
}

export function saveTeamConnection(connection: TeamConnection) {
  kvSet(
    CONNECTION_META_KEY,
    JSON.stringify({ serverUrl: connection.serverUrl, user: connection.user }),
  );
  kvSet(SERVER_HINT_KEY, connection.serverUrl);
  setCachedTokens({
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
  });
  void persistTokens();
}

export function clearTeamConnection() {
  kvRemove(CONNECTION_META_KEY);
  void clearStoredTokens();
}

export function readServerHint(): string {
  return kvGet(SERVER_HINT_KEY) ?? '';
}

function rememberServer(url: string) {
  kvSet(SERVER_HINT_KEY, url);
}

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function parseBody(status: number, text: string): unknown {
  if (status === 204 || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function notifySessionExpired(message: string) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('aw-team-session-expired', { detail: message }));
  }
}

interface TeamHttpResult {
  status: number;
  text: string;
}

function mapTransportError(error: unknown): TeamApiError {
  if (error instanceof TeamApiError) return error;
  const text = error instanceof Error ? error.message : String(error);
  if (
    text.includes('已阻止') ||
    text.includes('离线模式') ||
    text.includes('禁止解析') ||
    text.includes('只允许本机')
  ) {
    return new TeamApiError(0, 'network_blocked', text);
  }
  return new TeamApiError(0, 'network_error', '无法连接团队服务，请检查地址与网络');
}

async function teamHttp(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<TeamHttpResult> {
  if (isTauri) {
    try {
      const headers = Object.entries(init.headers ?? {}).map(([name, value]) => ({ name, value }));
      const response = await sendHttpRequest({
        method: init.method ?? 'GET',
        url,
        headers,
        body: init.body,
        timeoutMs: 30_000,
        network: backendNetworkOptions(currentNetworkMode()),
        useCookies: false,
        skipProbe: true,
      });
      return { status: response.status, text: response.body };
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
    });
  } catch (error) {
    throw mapTransportError(error);
  }
  return { status: response.status, text: await response.text() };
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

async function ensureServerAccess(serverUrl: string): Promise<void> {
  const access = await checkNetworkAccessResolved(serverUrl, currentNetworkMode());
  if (!access.allowed) {
    throw new TeamApiError(0, 'network_blocked', access.reason);
  }
}

async function publicRequest(
  serverUrl: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  if (!isTauri) {
    await ensureServerAccess(serverUrl);
  }
  const result = await teamHttp(`${serverUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = parseBody(result.status, result.text);
  if (result.status < 200 || result.status >= 300) {
    throw errorFromResponse(result.status, data);
  }
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
    const expired = new TeamApiError(401, 'session_expired', '登录已过期，请重新连接团队服务');
    notifySessionExpired(expired.message);
    throw expired;
  }
  if (!data?.accessToken || !data?.refreshToken) {
    clearTeamConnection();
    const expired = new TeamApiError(401, 'session_expired', '登录已过期，请重新连接团队服务');
    notifySessionExpired(expired.message);
    throw expired;
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
  if (!isTauri) {
    await ensureServerAccess(connection.serverUrl);
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${connection.accessToken}`,
    ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers ?? {}),
  };

  const result = await teamHttp(`${connection.serverUrl}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  if (result.status === 401 && retry) {
    await refreshConnection(connection);
    return teamRequest(connection, path, init, false);
  }

  const data = parseBody(result.status, result.text);
  if (result.status < 200 || result.status >= 300) {
    throw errorFromResponse(result.status, data);
  }
  return data;
}

export async function loginTeam(
  serverUrl: string,
  account: string,
  password: string,
): Promise<{ connection: TeamConnection; teams: RemoteTeam[]; mustChangePassword: boolean }> {
  const url = normalizeServerUrl(serverUrl);
  const login = (await publicRequest(url, '/v1/auth/login', {
    account: account.trim(),
    password,
  })) as {
    accessToken?: string;
    refreshToken?: string;
    mustChangePassword?: boolean;
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

  if (login.mustChangePassword === true) {
    rememberServer(url);
    saveTeamConnection(connection);
    return { connection, teams: [], mustChangePassword: true };
  }

  try {
    const me = (await teamRequest(connection, '/v1/me')) as { teams?: RemoteTeam[] };
    rememberServer(url);
    saveTeamConnection(connection);
    return { connection, teams: me.teams ?? [], mustChangePassword: false };
  } catch (error) {
    clearTeamConnection();
    throw error;
  }
}

export async function changeTeamPassword(
  connection: TeamConnection,
  currentPassword: string,
  newPassword: string,
): Promise<TeamConnection> {
  const result = (await teamRequest(connection, '/v1/auth/change-password', {
    method: 'POST',
    body: { currentPassword, newPassword },
  })) as {
    accessToken?: string;
    refreshToken?: string;
    user?: TeamConnectionUser;
  } | null;

  if (!result?.accessToken || !result.refreshToken) {
    throw new TeamApiError(0, 'invalid_response', '团队服务返回了无法识别的口令修改结果');
  }

  connection.accessToken = result.accessToken;
  connection.refreshToken = result.refreshToken;
  if (result.user) connection.user = result.user;
  saveTeamConnection(connection);
  return connection;
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
  encryptionKey?: string | null,
): Promise<{ revision: number; hash: string; createdAt: string }> {
  const body = encryptionKey
    ? await encryptSnapshotPayload(payload as Record<string, unknown>, encryptionKey)
    : payload;
  return (await teamRequest(connection, `/v1/teams/${teamId}/snapshots`, {
    method: 'POST',
    body,
    headers: {
      'X-Inkline-Base-Revision': String(baseRevision),
      'Idempotency-Key': crypto.randomUUID(),
    },
  })) as { revision: number; hash: string; createdAt: string };
}

export async function fetchLatestSnapshot(
  connection: TeamConnection,
  teamId: string,
  encryptionKey?: string | null,
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
  let payload = (await teamRequest(connection, meta.downloadUrl)) as Record<string, unknown>;
  if (isEncryptedPayload(payload)) {
    if (!encryptionKey) {
      throw new TeamApiError(
        0,
        'encryption_key_missing',
        '该团队快照已加密，请先在团队设置中导入团队密钥',
      );
    }
    payload = await decryptSnapshotPayload(payload, encryptionKey);
  }
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
