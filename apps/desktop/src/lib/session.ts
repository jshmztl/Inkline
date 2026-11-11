import { kvGet, kvRemove, kvSet } from './kv';

export type SessionMode = 'local' | 'team';

export interface TeamProfile {
  name: string;
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
        : parsed.mode === 'local' || workspace.includes('支付中台') || workspace === '本机工作区'
          ? 'local'
          : 'team';
    const name = String(parsed.name ?? parsed.account.split('@')[0] ?? parsed.account);

    return {
      mode,
      account: String(parsed.account),
      name,
      role: String(parsed.role ?? (mode === 'team' ? '团队成员' : '本机用户')),
      workspace: mode === 'local' ? '本机工作区' : workspace,
      team:
        mode === 'team'
          ? {
              name: String(parsed.team?.name ?? workspace),
              member: String(parsed.team?.member ?? name),
            }
          : undefined,
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

/** 团队模式：仅记录团队与成员标识，数据仍保存在本机。 */
export function enterTeam(
  teamName: string,
  memberName: string,
): Session | { error: string } {
  const team = teamName.trim();
  const member = memberName.trim();
  if (!team) return { error: '请输入团队名称' };
  if (!member) return { error: '请输入成员名称' };

  return persist({
    mode: 'team',
    account: member,
    name: member,
    role: '团队成员',
    workspace: team,
    team: { name: team, member },
    signedAt: new Date().toISOString(),
  });
}

/** 修改团队名称或成员名称，保持当前会话其余信息不变。 */
export function saveTeamProfile(
  teamName: string,
  memberName: string,
): Session | { error: string } {
  const current = readSession();
  if (!current || current.mode !== 'team') {
    return { error: '当前不是团队工作区' };
  }

  const team = teamName.trim();
  const member = memberName.trim();
  if (!team) return { error: '请输入团队名称' };
  if (!member) return { error: '请输入成员名称' };

  return persist({
    ...current,
    account: member,
    name: member,
    workspace: team,
    team: { name: team, member },
  });
}

export function signOut() {
  try {
    kvRemove(storageKey);
  } catch {
    // 忽略存储清理失败。
  }
}
