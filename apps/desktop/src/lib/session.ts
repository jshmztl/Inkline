export interface Session {
  account: string;
  name: string;
  role: string;
  workspace: string;
  signedAt: string;
}

interface Account {
  password: string;
  name: string;
  role: string;
}

const storageKey = 'aw-session';

const accounts: Record<string, Account> = {
  'admin@internal': { password: 'demo1234', name: '林默', role: '平台管理员' },
  'dev@internal': { password: 'demo1234', name: '陈屿', role: '接口开发' },
};

export function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    if (!parsed?.account || !parsed?.workspace) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function signIn(account: string, password: string): Session | { error: string } {
  const normalized = account.trim().toLowerCase();
  const entry = accounts[normalized];

  if (!entry || entry.password !== password) {
    return { error: '账号或口令不正确' };
  }

  const session: Session = {
    account: normalized,
    name: entry.name,
    role: entry.role,
    workspace: '支付中台 · 团队工作区',
    signedAt: new Date().toISOString(),
  };

  try {
    localStorage.setItem(storageKey, JSON.stringify(session));
  } catch {
    // 存储不可用时仍允许本次会话使用。
  }

  return session;
}

export function signOut() {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // 忽略存储清理失败。
  }
}
