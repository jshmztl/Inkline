// 管理台公共上下文：状态、DOM 引用、格式化工具、会话与 API 客户端。
export const TOKEN_KEY = 'inkline_admin_access';
export const REFRESH_KEY = 'inkline_admin_refresh';
export const TEAM_KEY = 'inkline_admin_team';

export const $ = (sel) => document.querySelector(sel);
export const loginPage = $('#login');
export const app = $('#app');
export const teamList = $('#team-list');
export const empty = $('#empty');
export const teamView = $('#team-view');
export const toast = $('#toast');
export const payloadDialog = $('#payload-dialog');
export const payloadBody = $('#payload-body');
export const payloadTitle = $('#payload-title');
export const diffDialog = $('#diff-dialog');
export const diffTitle = $('#diff-title');
export const diffBody = $('#diff-body');
export const diffSummary = $('#diff-summary');
export const diffOutline = $('#diff-outline');
export const diffNavPos = $('#diff-nav-pos');
export const diffState = { blocks: [], outline: [], index: -1, jumpUntil: 0, focusTimer: 0, scrollRaf: 0 };
export const teamDialog = $('#team-dialog');
export const memberDialog = $('#member-dialog');
export const passwordDialog = $('#password-dialog');
export const confirmDialog = $('#confirm-dialog');

export const roleLabels = { owner: '所有者', admin: '管理员', member: '成员', viewer: '只读' };
export const dataLevels = {
  L0: { label: '公开', note: '可对外公开，不包含内部信息' },
  L1: { label: '内部', note: '仅限团队内部使用，默认允许同步' },
  L2: { label: '敏感', note: '仅限授权人员，需要所有者显式开启' },
  L3: { label: '机密', note: '禁止进入团队服务，仅保留在本机' },
};
export const tabNames = ['overview', 'members', 'permissions', 'content', 'snapshots', 'audit', 'settings'];

export const state = {
  access: '',
  refresh: '',
  pendingPassword: '',
  me: null,
  teams: [],
  team: null,
  members: [],
  latest: null,
  history: [],
  historyCursor: null,
  audit: null,
  permission: null,
  tab: 'overview',
  memberMode: 'create',
  memberTarget: null,
  permSelected: null,
  permDraft: null,
  permApplyAll: false,
  workspace: null,
  contentSelected: null,
  exportFormat: 'markdown',
  auditType: '',
};

// 由 app.js 注册的跨模块导航动作，避免视图模块反向依赖入口模块。
export const nav = {
  selectTeam: () => {},
  switchTab: () => {},
  renderTeamList: () => {},
  renderTeam: () => {},
};

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'checked' || key === 'selected' || key === 'disabled') {
      if (value) el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function showToast(message, tone = 'ok') {
  toast.textContent = message;
  toast.className = 'toast' + (tone === 'error' ? ' error' : '');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), 3600);
}

export function fmtTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function dataLevelText(value) {
  const item = dataLevels[value];
  return item ? `${value} · ${item.label}` : (value || '-');
}

export function fmtBytes(value) {
  if (value === null || value === undefined) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = Number(value);
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return (index === 0 ? size : size.toFixed(1)) + ' ' + units[index];
}

export function shortHash(hash) {
  if (!hash) return '-';
  return hash.length > 22 ? hash.slice(0, 18) + '…' : hash;
}

export function randomPassword() {
  const letters = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const symbols = '!@#%';
  const alphabet = letters + digits + symbols;
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  let out = letters[bytes[0] % letters.length] + digits[bytes[1] % digits.length];
  for (let i = 2; i < 16; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function paintJson(target, value) {
  const text = String(value ?? '');
  const regex = /"(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let last = 0;
  let match;
  while ((match = regex.exec(text))) {
    if (match.index > last) {
      target.append(document.createTextNode(text.slice(last, match.index)));
    }
    const token = match[0];
    let tone = 'tok-number';
    if (token.startsWith('"')) {
      tone = /^\s*:/.test(text.slice(regex.lastIndex)) ? 'tok-key' : 'tok-string';
    } else if (token === 'true' || token === 'false') {
      tone = 'tok-bool';
    } else if (token === 'null') {
      tone = 'tok-null';
    }
    target.append(h('span', { class: tone, text: token }));
    last = regex.lastIndex;
  }
  if (last < text.length) {
    target.append(document.createTextNode(text.slice(last)));
  }
  return target;
}

export function codeBlock(text) {
  const value = String(text ?? '');
  try {
    JSON.parse(value);
  } catch {
    return h('pre', { class: 'code-block', text: value });
  }
  return h('pre', { class: 'code-block' },
    paintJson(document.createDocumentFragment(), value),
  );
}

export function saveTokens() {
  sessionStorage.setItem(TOKEN_KEY, state.access);
  sessionStorage.setItem(REFRESH_KEY, state.refresh);
}

export function clearSession() {
  state.access = '';
  state.refresh = '';
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(REFRESH_KEY);
}

export function loadTokens() {
  state.access = sessionStorage.getItem(TOKEN_KEY) || '';
  state.refresh = sessionStorage.getItem(REFRESH_KEY) || '';
}

export async function refreshSession() {
  if (!state.refresh) throw new Error('登录已过期');
  const response = await fetch('/v1/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: state.refresh }),
  });
  if (!response.ok) throw new Error('登录已过期');
  const data = await response.json();
  state.access = data.accessToken;
  state.refresh = data.refreshToken;
  saveTokens();
}

export async function authorizedFetch(path, options = {}, retry = true) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (state.access) headers.set('Authorization', 'Bearer ' + state.access);
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401 && retry && state.refresh) {
    try {
      await refreshSession();
      return authorizedFetch(path, options, false);
    } catch {
      clearSession();
    }
  }
  return response;
}

export async function api(path, options = {}) {
  const response = await authorizedFetch(path, options);
  if (response.status === 204) return null;
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.message || `请求失败（${response.status}）`);
    error.code = data?.error?.code;
    error.status = response.status;
    if (response.status === 401) {
      clearSession();
      showLogin();
    }
    if (response.status === 403 && data?.error?.code === 'password_change_required') {
      clearSession();
      showLogin();
    }
    throw error;
  }
  return data;
}

export function showLogin() {
  loginPage.classList.remove('hidden');
  app.classList.add('hidden');
  state.pendingPassword = '';
  $('#login-form').classList.remove('hidden');
  $('#force-password-form').classList.add('hidden');
  $('#force-password-error').textContent = '';
}

export function showApp() {
  loginPage.classList.add('hidden');
  app.classList.remove('hidden');
}

export function rolePill(role) {
  const tone = role === 'owner' ? 'accent' : role === 'admin' ? 'ok' : '';
  return h('span', { class: 'pill ' + tone, text: roleLabels[role] || role || '-' });
}

export function isManager() {
  return state.team && ['owner', 'admin'].includes(state.team.role);
}

export function confirmAction({ title, text, onConfirm }) {
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  const ok = $('#confirm-ok');
  const replacement = ok.cloneNode(true);
  ok.replaceWith(replacement);
  replacement.addEventListener('click', async () => {
    replacement.disabled = true;
    try {
      await onConfirm();
      confirmDialog.close();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      replacement.disabled = false;
    }
  });
  confirmDialog.showModal();
}
