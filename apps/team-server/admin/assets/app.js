import { $, h, state, nav, tabNames, roleLabels, rolePill, isManager, api, showToast, clearSession, loadTokens, saveTokens, showLogin, showApp, randomPassword, teamDialog, memberDialog, passwordDialog, confirmDialog, payloadDialog, diffDialog, diffOutline, diffBody, empty, teamView, teamList, TEAM_KEY } from './core.js';
import { renderStats, renderOverview, renderSettings } from './overview.js';
import { renderMembers, syncMemberMode, submitMember, submitPassword } from './members.js';
import { renderPermissions, loadPermissions } from './permissions.js';
import { renderContent, loadWorkspace } from './content.js';
import { renderSnapshots } from './snapshots.js';
import { renderAudit, loadAudit } from './audit.js';
import { jumpDiffChange, jumpDiffSection, onDiffScroll } from './diff.js';

function renderTeamList() {
  teamList.replaceChildren();
  if (!state.teams.length) {
    teamList.append(h('p', { class: 'muted side-empty', text: '还没有团队' }));
    return;
  }
  for (const team of state.teams) {
    const active = state.team && state.team.id === team.id;
    const item = h('button', { class: `team-item${active ? ' active' : ''}`, type: 'button' },
      h('strong', { text: team.name }),
      h('span', {
        class: 'muted',
        text: `${roleLabels[team.role] || team.role} · #${team.revision} · ${team.memberCount} 人`,
      }),
    );
    item.addEventListener('click', () => selectTeam(team.id));
    teamList.append(item);
  }
}

function renderTeam() {
  const team = state.team;
  if (!team) {
    empty.classList.remove('hidden');
    teamView.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  teamView.classList.remove('hidden');
  $('#team-name').textContent = team.name;
  const role = rolePill(team.role);
  role.id = 'team-role';
  $('#team-role').replaceWith(role);
  renderStats(team);
  renderOverview();
  renderMembers();
  renderPermissions();
  renderContent();
  renderSnapshots();
  renderAudit();
  renderSettings();
  switchTab(state.tab);
}

function switchTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll('#tabs button')) {
    button.classList.toggle('active', button.dataset.tab === tab);
  }
  for (const name of tabNames) {
    $('#tab-' + name).classList.toggle('hidden', name !== tab);
  }
  if (tab === 'permissions' && isManager() && !state.permission) void loadPermissions();
  if (tab === 'content' && isManager() && !state.workspace) void loadWorkspace();
  if (tab === 'audit' && isManager() && state.audit === null) void loadAudit();
}

async function selectTeam(id) {
  sessionStorage.setItem(TEAM_KEY, id);
  try {
    const [detail, members, latest, history] = await Promise.all([
      api(`/v1/teams/${id}`),
      api(`/v1/teams/${id}/members`),
      api(`/v1/teams/${id}/snapshots/latest`).catch(() => null),
      api(`/v1/teams/${id}/snapshots?limit=20`),
    ]);
    state.team = detail.team;
    state.members = members.members || [];
    state.latest = latest;
    state.history = history.entries || [];
    state.historyCursor = history.nextCursor;
    state.audit = null;
    state.permission = null;
    state.permSelected = null;
    state.permDraft = null;
    state.permApplyAll = false;
    state.workspace = null;
    state.contentSelected = null;
    state.auditType = '';
    state.tab = 'overview';

    if (isManager()) {
      await Promise.all([loadPermissions(), loadAudit()]);
    }

    const index = state.teams.findIndex((item) => item.id === id);
    if (index >= 0) state.teams[index] = { ...state.teams[index], ...state.team };
    renderTeamList();
    renderTeam();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function boot() {
  loadTokens();
  if (!state.access) {
    showLogin();
    return;
  }
  try {
    const me = await api('/v1/me');
    state.me = me.user;
    state.teams = me.teams || [];
    $('#user-label').textContent = `${me.user.displayName} · ${me.user.account}`;
    showApp();
    if (!state.teams.length) {
      renderTeamList();
      state.team = null;
      renderTeam();
      return;
    }
    const saved = sessionStorage.getItem(TEAM_KEY);
    const target = state.teams.find((team) => team.id === saved) || state.teams[0];
    await selectTeam(target.id);
  } catch {
    clearSession();
    showLogin();
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const errorBox = $('#login-error');
  const button = $('#login-submit');
  errorBox.textContent = '';
  button.disabled = true;
  try {
    const data = await api('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        account: $('#account').value.trim(),
        password: $('#password').value,
      }),
    });
    state.access = data.accessToken;
    state.refresh = data.refreshToken;
    state.pendingPassword = $('#password').value;
    saveTokens();

    if (data.mustChangePassword) {
      $('#password').value = '';
      $('#login-form').classList.add('hidden');
      $('#force-password-form').classList.remove('hidden');
      $('#force-password-error').textContent = '';
      $('#force-new-password').value = '';
      $('#force-confirm-password').value = '';
      $('#force-new-password').focus();
      return;
    }

    state.pendingPassword = '';
    await boot();
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function handleForcePassword(event) {
  event.preventDefault();
  const errorBox = $('#force-password-error');
  const button = $('#force-password-submit');
  const next = $('#force-new-password').value;
  const confirm = $('#force-confirm-password').value;
  errorBox.textContent = '';

  if (next.length < 8 || !/[A-Za-z]/.test(next) || !/\d/.test(next)) {
    errorBox.textContent = '口令至少 8 位，且需要同时包含字母和数字';
    return;
  }
  if (next !== confirm) {
    errorBox.textContent = '两次输入的口令不一致';
    return;
  }
  if (next === state.pendingPassword) {
    errorBox.textContent = '新口令不能与当前口令相同';
    return;
  }

  button.disabled = true;
  try {
    const data = await api('/v1/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: state.pendingPassword,
        newPassword: next,
      }),
    });
    state.access = data.accessToken;
    state.refresh = data.refreshToken;
    state.pendingPassword = '';
    saveTokens();
    $('#login-form').classList.remove('hidden');
    $('#force-password-form').classList.add('hidden');
    $('#password').value = '';
    await boot();
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function handleLogout() {
  const refreshToken = state.refresh;
  clearSession();
  showLogin();
  state.team = null;
  state.teams = [];
  state.members = [];
  state.permission = null;
  sessionStorage.removeItem(TEAM_KEY);
  if (refreshToken) {
    fetch('/v1/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => {});
  }
}

async function createTeam(event) {
  event.preventDefault();
  const name = $('#new-team-name').value.trim();
  if (!name) return;
  try {
    const result = await api('/v1/teams', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    teamDialog.close();
    $('#new-team-name').value = '';
    await boot();
    showToast('团队已创建');
    await selectTeam(result.team.id);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function loadMeta() {
  try {
    const meta = await fetch('/v1/meta').then((response) => response.json());
    const text = `${meta.name === 'inkline-team-server' ? 'Inkline 团队服务' : meta.name} · v${meta.version}`;
    $('#login-meta').textContent = text;
    $('#login-foot').textContent = `快照上限 ${Math.round(meta.limits.maxUncompressedBytes / 1024 / 1024)} MB · 保留 ${meta.retention.snapshotDays} 天`;
    $('#server-meta').textContent = text;
  } catch {
    // 元信息不可用时不影响登录。
  }
}

Object.assign(nav, { selectTeam, switchTab, renderTeamList, renderTeam });

$('#login-form').addEventListener('submit', handleLogin);
$('#force-password-form').addEventListener('submit', handleForcePassword);
$('#logout').addEventListener('click', handleLogout);
$('#refresh').addEventListener('click', () => (state.team ? selectTeam(state.team.id) : boot()));
$('#new-team').addEventListener('click', () => teamDialog.showModal());
$('#team-cancel').addEventListener('click', () => teamDialog.close());
$('#team-form').addEventListener('submit', createTeam);
$('#payload-close').addEventListener('click', () => payloadDialog.close());
payloadDialog.addEventListener('click', (event) => {
  if (event.target === payloadDialog) payloadDialog.close();
});
$('#diff-close').addEventListener('click', () => diffDialog.close());
diffDialog.addEventListener('click', (event) => {
  if (event.target === diffDialog) diffDialog.close();
});
$('#diff-prev').addEventListener('click', () => jumpDiffChange(-1));
$('#diff-next').addEventListener('click', () => jumpDiffChange(1));
diffOutline.addEventListener('click', (event) => {
  const button = event.target.closest('.diff-outline-item');
  if (button) jumpDiffSection(button.dataset.target);
});
diffBody.addEventListener('scroll', onDiffScroll, { passive: true });

$('#mode-create').addEventListener('click', () => { state.memberMode = 'create'; syncMemberMode(); });
$('#mode-existing').addEventListener('click', () => { state.memberMode = 'existing'; syncMemberMode(); });
$('#member-generate').addEventListener('click', () => { $('#member-password').value = randomPassword(); });
$('#password-generate').addEventListener('click', () => { $('#reset-password').value = randomPassword(); });
$('#member-cancel').addEventListener('click', () => memberDialog.close());
$('#member-form').addEventListener('submit', submitMember);
$('#password-cancel').addEventListener('click', () => passwordDialog.close());
$('#password-form').addEventListener('submit', submitPassword);
$('#confirm-cancel').addEventListener('click', () => confirmDialog.close());

for (const button of document.querySelectorAll('#tabs button')) {
  button.addEventListener('click', () => switchTab(button.dataset.tab));
}

loadMeta();
boot();
