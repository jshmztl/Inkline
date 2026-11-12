import { kvGet, kvRemove, kvSet } from './kv';

export type SessionMode = 'local' | 'team';

export interface TeamProfile {
  id: string;
  name: string;
  role: string;
  serverUrl: string;
  member: string;
}

export interface Session {
  mode: SessionMode;
  account: string;
  name: string;
  role: string;
  workspace: string;
  team?: TeamProfile;
  signedAt: string;
}

const storageKey = 'aw-session';

function persist(session: Session): Session {
  try {
    kvSet(storageKey, JSON.stringify(session));
  } catch {
    // 存储不可用时仍允许本次会话使用。
  }
  return session;
}

export function readSession(): Session | null {
  try {
    const raw = kvGet(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (!parsed?.account || !parsed?.workspace) return null;

    const workspace = String(parsed.workspace);
    const mode: SessionMode =
      parsed.mode === 'team'
        ? 'team'
        : parsed.mode === 'local' || workspace === '本机工作区'
          ? 'local'
          : 'team';

    if (mode === 'team') {
      const team = parsed.team;
      // 旧版本只记录了团队名称，没有真实服务端连接，需要重新登录。
      if (!team?.id || !team?.serverUrl) return null;
      return {
        mode,
        account: String(parsed.account),
        name: String(parsed.name ?? parsed.account),
        role: String(team.role ?? parsed.role ?? 'member'),
        workspace: String(team.name ?? workspace),
        team: {
          id: String(team.id),
          name: String(team.name),
          role: String(team.role ?? parsed.role ?? 'member'),
          serverUrl: String(team.serverUrl),
          member: String(team.member ?? parsed.name ?? parsed.account),
        },
        signedAt: String(parsed.signedAt ?? new Date().toISOString()),
      };
    }

    const name = String(parsed.name ?? parsed.account.split('@')[0] ?? parsed.account);
    return {
      mode: 'local',
      account: String(parsed.account),
      name,
      role: String(parsed.role ?? '本机用户'),
      workspace: '本机工作区',
      signedAt: String(parsed.signedAt ?? new Date().toISOString()),
    };
  } catch {
    return null;
  }
}

/** 本机模式：不需要账号口令，直接进入本地工作区。 */
export function enterLocal(): Session {
  return persist({
    mode: 'local',
    account: 'local',
    name: '本机用户',
    role: '本机用户',
    workspace: '本机工作区',
    signedAt: new Date().toISOString(),
  });
}

/** 团队模式：登录团队服务并选择团队后建立会话。 */
export function enterTeamSession(
  serverUrl: string,
  user: { account: string; displayName: string },
  team: { id: string; name: string; role: string },
): Session {
  const member = user.displayName || user.account;
  return persist({
    mode: 'team',
    account: user.account,
    name: member,
    role: team.role,
    workspace: team.name,
    team: {
      id: team.id,
      name: team.name,
      role: team.role,
      serverUrl,
      member,
    },
    signedAt: new Date().toISOString(),
  });
}

export function signOut() {
  try {
    kvRemove(storageKey);
  } catch {
    // 忽略存储清理失败。
  }
}
