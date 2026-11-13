import { $, h, state, api, showToast, fmtTime, isManager } from './core.js';

function renderAudit() {
  const card = h('div', { class: 'card' });
  const filter = h('select', {},
    ...[['', '全部类型'], ['sync', '同步'], ['member', '成员'], ['permission', '权限'], ['team', '团队'], ['auth', '认证']].map(([value, label]) =>
      h('option', { value, text: label, selected: value === state.auditType })),
  );
  filter.addEventListener('change', async () => {
    state.auditType = filter.value;
    await loadAudit();
  });
  card.append(h('div', { class: 'card-head' },
    h('h3', { text: '审计日志' }),
    h('div', { class: 'actions' }, filter, h('span', { class: 'muted', text: state.audit ? `${state.audit.length} 条` : '' })),
  ));

  if (state.audit === null) {
    card.append(h('p', { class: 'section-note', text: '仅团队所有者或管理员可以查看审计日志。' }));
    $('#tab-audit').replaceChildren(card);
    return;
  }

  if (!state.audit.length) {
    card.append(h('p', { class: 'section-note', text: '暂无审计记录。' }));
    $('#tab-audit').replaceChildren(card);
    return;
  }

  const rows = state.audit.map((entry) => h('tr', {},
    h('td', { text: fmtTime(entry.at) }),
    h('td', {}, h('span', { class: 'badge', text: entry.type })),
    h('td', { text: entry.action }),
    h('td', { text: entry.actor?.displayName || '-' }),
    h('td', {}, h('code', { text: JSON.stringify(entry.detail || {}).slice(0, 120) })),
  ));

  card.append(h('div', { class: 'table-wrap' },
    h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ...['时间', '类型', '操作', '操作人', '详情'].map((text) => h('th', { text })))),
      h('tbody', {}, ...rows),
    ),
  ));
  $('#tab-audit').replaceChildren(card);
}

async function loadAudit() {
  if (!isManager()) {
    state.audit = null;
    renderAudit();
    return;
  }
  try {
    const query = state.auditType ? `&type=${encodeURIComponent(state.auditType)}` : '';
    state.audit = (await api(`/v1/teams/${state.team.id}/audit?limit=100${query}`)).entries || [];
  } catch {
    state.audit = null;
  }
  renderAudit();
}

export { renderAudit, loadAudit };
