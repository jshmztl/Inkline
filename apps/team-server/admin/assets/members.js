import { $, h, state, roleLabels, rolePill, api, showToast, fmtTime, isManager, confirmAction, memberDialog, passwordDialog, nav } from './core.js';
import { renderStats } from './overview.js';

function canManageMember(target) {
  const actor = state.team?.role;
  if (!actor) return false;
  if (target.userId === state.me?.id) return false;
  if (actor === 'owner') return target.role !== 'owner';
  if (actor === 'admin') return target.role === 'member' || target.role === 'viewer';
  return false;
}

function memberRoleSelect(member) {
  if (!canManageMember(member)) return rolePill(member.role);
  const options = state.team.role === 'owner' ? ['admin', 'member', 'viewer'] : ['member', 'viewer'];
  const select = h('select', {},
    ...options.map((role) => h('option', { value: role, text: roleLabels[role], selected: role === member.role })),
  );
  select.addEventListener('change', async () => {
    select.disabled = true;
    try {
      const result = await api(`/v1/teams/${state.team.id}/members/${member.userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: select.value }),
      });
      const index = state.members.findIndex((item) => item.userId === member.userId);
      if (index >= 0) state.members[index] = result.member;
      state.team.memberCount = state.members.length;
      renderStats(state.team);
      renderMembers();
      showToast('角色已更新');
    } catch (error) {
      showToast(error.message, 'error');
      renderMembers();
    }
  });
  return select;
}

function renderMembers() {
  const container = $('#tab-members');
  const card = h('div', { class: 'card' });
  const head = h('div', { class: 'card-head' },
    h('h3', { text: '团队成员' }),
    h('div', { class: 'actions' },
      h('span', { class: 'muted', text: `${state.members.length} 人` }),
      isManager() ? h('button', {
        class: 'btn primary small', type: 'button', text: '+ 添加成员', onclick: openMemberDialog,
      }) : null,
    ),
  );
  card.append(head);

  if (!state.members.length) {
    card.append(h('p', { class: 'section-note', text: '暂无成员。' }));
    container.replaceChildren(card);
    return;
  }

  const rows = state.members.map((member) => {
    const actions = [];
    if (isManager() && (state.team.role === 'owner' || ['member', 'viewer'].includes(member.role))) {
      actions.push(h('button', {
        class: 'btn small', type: 'button', text: '重置口令',
        onclick: () => openPasswordDialog(member),
      }));
    }
    if (canManageMember(member)) {
      actions.push(h('button', {
        class: 'btn small danger', type: 'button', text: '移除',
        onclick: () => removeMember(member),
      }));
    }
    const initial = (member.displayName || member.account || '?').slice(0, 1).toUpperCase();
    return h('tr', {},
      h('td', {}, h('div', { class: 'member-cell' }, h('span', { class: 'avatar', text: initial }), h('strong', { text: member.displayName }))),
      h('td', {}, h('code', { text: member.account })),
      h('td', {}, memberRoleSelect(member)),
      h('td', { text: fmtTime(member.joinedAt) }),
      h('td', {}, actions.length ? h('div', { class: 'row-actions' }, ...actions) : h('span', { class: 'muted', text: '—' })),
    );
  });

  card.append(h('div', { class: 'table-wrap' },
    h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ...['成员', '账号', '角色', '加入时间', '操作'].map((text) => h('th', { text })))),
      h('tbody', {}, ...rows),
    ),
  ));
  card.append(h('p', { class: 'section-note', text: '所有者可管理管理员及以下角色；管理员可管理成员与只读账号；移除成员会同时撤销其资源授权。' }));
  container.replaceChildren(card);
}

function openMemberDialog() {
  state.memberMode = 'create';
  $('#member-account').value = '';
  $('#member-display').value = '';
  $('#member-password').value = '';
  $('#member-role').value = 'member';
  $('#member-role').querySelectorAll('option').forEach((option) => {
    option.disabled = option.value === 'admin' && state.team.role !== 'owner';
  });
  syncMemberMode();
  memberDialog.showModal();
}

function syncMemberMode() {
  const create = state.memberMode === 'create';
  $('#mode-create').classList.toggle('active', create);
  $('#mode-existing').classList.toggle('active', !create);
  $('#display-field').classList.toggle('hidden', !create);
  $('#password-field').classList.toggle('hidden', !create);
  $('#member-mode-note').textContent = create
    ? '新建账号会同时创建服务账号并加入当前团队。'
    : '填写已存在的服务账号，直接加入当前团队，沿用原口令。';
}

async function submitMember(event) {
  event.preventDefault();
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const payload = {
      mode: state.memberMode,
      account: $('#member-account').value.trim(),
      role: $('#member-role').value,
    };
    if (state.memberMode === 'create') {
      payload.displayName = $('#member-display').value.trim() || payload.account;
      payload.password = $('#member-password').value;
    }
    await api(`/v1/teams/${state.team.id}/members`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    memberDialog.close();
    await nav.selectTeam(state.team.id);
    showToast('成员已添加');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function openPasswordDialog(member) {
  state.memberTarget = member;
  $('#password-title').textContent = `重置口令 · ${member.displayName}`;
  $('#reset-password').value = '';
  passwordDialog.showModal();
}

async function submitPassword(event) {
  event.preventDefault();
  if (!state.memberTarget) return;
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api(`/v1/teams/${state.team.id}/members/${state.memberTarget.userId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword: $('#reset-password').value }),
    });
    passwordDialog.close();
    showToast('口令已重置，请告知成员');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function removeMember(member) {
  confirmAction({
    title: '移除成员',
    text: `确认将 ${member.displayName}（${member.account}）移出团队？其团队内资源授权会一并撤销。`,
    onConfirm: async () => {
      await api(`/v1/teams/${state.team.id}/members/${member.userId}`, { method: 'DELETE' });
      await nav.selectTeam(state.team.id);
      showToast('成员已移除');
    },
  });
}

export { canManageMember, memberRoleSelect, renderMembers, openMemberDialog, syncMemberMode, submitMember, openPasswordDialog, submitPassword, removeMember };
