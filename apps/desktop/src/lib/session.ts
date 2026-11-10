import { kvGet, kvRemove, kvSet } from './kv';

export interface Session {
  account: string;
  name: string;
  role: string;
  workspace: string;
  signedAt: string;
}

const storageKey = 'aw-session';

export function readSession(): Session | null {
  try {
    const raw = kvGet(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    if (!parsed?.account || !parsed?.workspace) return null;
    if (parsed.workspace.includes('支付中台')) {
      parsed.workspace = '本机工作区';
      parsed.role = '本机用户';
      parsed.name = parsed.account.split('@')[0] || parsed.account;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function signIn(account: string, password: string): Session | { error: string } {
  const normalized = account.trim().toLowerCase();
  if (!normalized) {
    return { error: '请输入本机账号' };
  }
  if (!password) {
    return { error: '请输入口令' };
  }

  const session: Session = {
    account: normalized,
    name: normalized.split('@')[0] || normalized,
    role: '本机用户',
    workspace: '本机工作区',
    signedAt: new Date().toISOString(),
  };

  try {
    kvSet(storageKey, JSON.stringify(session));
  } catch {
    // 存储不可用时仍允许本次会话使用。
  }

  return session;
}

export function signOut() {
  try {
    kvRemove(storageKey);
  } catch {
    // 忽略存储清理失败。
  }
}
