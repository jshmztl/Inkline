import { $, h, state, api, showToast, fmtTime, isManager } from './core.js';

const typeLabels = {
  auth: '认证',
  member: '成员',
  permission: '权限',
  team: '团队',
  sync: '同步',
  encryption: '加密',
  audit: '审计',
  request: '请求',
  'ai-task': 'AI',
  egress: '出网',
};

const actionLabels = {
  'auth.login': '登录',
  'auth.login_locked': '登录锁定',
  'auth.password_change': '修改口令',
  'member.create': '创建成员',
  'member.add': '添加成员',
  'member.role_update': '修改成员角色',
  'member.remove': '移除成员',
  'member.password_reset': '重置成员口令',
  'team.create': '创建团队',
  'team.update': '更新团队设置',
  'snapshot.push': '推送快照',
  'snapshot.rollback': '回滚快照',
  'permission.update': '更新权限',
  'permission.reset': '重置权限',
  'permission.batch_update': '批量更新权限',
  'encryption.device.register': '注册加密设备',
  'encryption.key.create': '创建团队密钥',
  'encryption.key.distribute': '分发团队密钥',
  'encryption.escrow.store': '托管团队密钥',
  'encryption.escrow.enable': '开启服务端审阅',
  'encryption.escrow.disable': '关闭服务端审阅',
  'audit.cleanup': '清理审计日志',
};

function typeLabel(value) {
  return typeLabels[value] || value || '-';
}

function actionLabel(value) {
  return actionLabels[value] || value || '-';
}

function renderAudit() {
  const card = h('div', { class: 'card' });
  const filter = h('select', {},
    ...[
      ['', '全部类型'],
      ['sync', '同步'],
      ['member', '成员'],
      ['permission', '权限'],
      ['team', '团队'],
      ['auth', '认证'],
      ['encryption', '加密'],
      ['audit', '审计'],
    ].map(([value, label]) =>
      h('option', { value, text: label, selected: value === state.auditType })),
  );
  filter.addEventListener('change', async () => {
    state.auditType = filter.value;
    await loadAudit();
  });

  const cleanupDays = h('select', {},
    ...[30, 90, 180, 365].map((days) =>
      h('option', { value: String(days), text: `清理 ${days} 天前` })),
  );
  const cleanup = h('button', { class: 'btn small', type: 'button', text: '清理' });
  cleanup.addEventListener('click', async () => {
    const days = Number(cleanupDays.value);
    if (!confirm(`确定清理 ${days} 天前的审计日志吗？此操作不可恢复。`)) return;
    try {
      const result = await api(
        `/v1/teams/${state.team.id}/audit?beforeDays=${days}`,
        { method: 'DELETE' },
      );
      showToast(`已清理 ${result.deleted} 条审计日志`);
      await loadAudit();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  card.append(h('div', { class: 'card-head' },
    h('h3', { text: '审计日志' }),
    h('div', { class: 'actions' },
      filter,
      cleanupDays,
      cleanup,
      h('span', { class: 'muted', text: state.audit ? `${state.audit.length} 条` : '' }),
    ),
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
    h('td', {}, h('span', { class: 'badge', text: typeLabel(entry.type) })),
    h('td', { title: entry.action }, h('span', { text: actionLabel(entry.action) })),
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
