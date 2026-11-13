import { $, h, state, dataLevels, dataLevelText, fmtTime, fmtBytes, shortHash, api, showToast, nav } from './core.js';
import { openPayload, downloadSnapshot } from './snapshots.js';

function stat(label, value) {
  return h('div', { class: 'stat' },
    h('span', { class: 'stat-label', text: label }),
    h('strong', { class: 'stat-value', text: String(value) }),
  );
}

function restrictedCount() {
  if (!state.permission) return '—';
  const collections = state.permission.collections.filter((item) => item.visibility === 'restricted').length;
  const requests = state.permission.requests.filter((item) => item.visibility === 'restricted').length;
  return collections + requests;
}

function renderStats(team) {
  $('#stats').replaceChildren(
    stat('当前版本', '#' + team.revision),
    stat('成员数', team.memberCount),
    stat('数据分级上限', dataLevelText(team.maxDataLevel)),
    stat('快照保留', team.snapshotRetentionDays + ' 天'),
    stat('审计保留', team.auditRetentionDays + ' 天'),
    stat('受限资源', restrictedCount()),
  );
  $('#team-revision').textContent = '当前版本 #' + team.revision;
}

function kv(label, value) {
  const strong = typeof value === 'string'
    ? h('strong', { text: value })
    : h('strong', {}, value);
  return h('div', { class: 'kv' }, h('label', { text: label }), strong);
}

function snapshotCard() {
  const card = h('div', { class: 'card' });
  card.append(h('div', { class: 'card-head' },
    h('h3', { text: '最新快照' }),
    state.latest ? h('span', { class: 'pill ok', text: '#' + state.latest.revision }) : h('span', { class: 'pill', text: '暂无' }),
  ));

  if (!state.latest) {
    card.append(h('p', { class: 'section-note', text: '团队还没有推送过快照。客户端完成一次 push 后会出现在这里。' }));
    return card;
  }

  card.append(h('div', { class: 'kv-grid' },
    kv('上传者', state.latest.createdBy?.displayName || '-'),
    kv('时间', fmtTime(state.latest.createdAt)),
    kv('大小', fmtBytes(state.latest.sizeBytes)),
    kv('Hash', h('code', { text: shortHash(state.latest.hash) })),
  ));

  const view = h('button', { class: 'btn small', type: 'button', text: '查看内容' });
  view.addEventListener('click', () => openPayload(state.latest.revision));
  const download = h('button', { class: 'btn small', type: 'button', text: '下载 JSON' });
  download.addEventListener('click', () => downloadSnapshot(state.latest.revision));
  card.append(h('div', { class: 'actions' }, view, download));
  return card;
}

function settingsCard(team) {
  const card = h('div', { class: 'card' });
  card.append(h('div', { class: 'card-head' }, h('h3', { text: '团队设置' })));

  if (team.role !== 'owner') {
    card.append(h('p', { class: 'section-note', text: '只有团队所有者可以修改名称、数据分级与保留策略。' }));
    return card;
  }

  const name = h('input', { value: team.name, maxlength: '80', required: true });
  const level = h('select', {},
    ...['L0', 'L1', 'L2'].map((value) => h('option', {
      value,
      text: `${value} · ${dataLevels[value].label}${value === 'L1' ? '（默认）' : ''}`,
      selected: value === team.maxDataLevel,
    })),
  );
  const snapshotDays = h('input', { type: 'number', min: '7', max: '3650', value: team.snapshotRetentionDays, required: true });
  const auditDays = h('input', { type: 'number', min: '7', max: '3650', value: team.auditRetentionDays, required: true });

  const form = h('form', { class: 'settings-form' },
    h('div', { class: 'field wide' }, h('label', { text: '团队名称' }), name),
    h('div', { class: 'field' }, h('label', { text: '数据分级上限' }), level),
    h('div', { class: 'field' }, h('label', { text: '快照保留天数' }), snapshotDays),
    h('div', { class: 'field' }, h('label', { text: '审计保留天数' }), auditDays),
    h('div', { class: 'wide actions' }, h('button', { class: 'btn primary', type: 'submit', text: '保存设置' })),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const result = await api(`/v1/teams/${team.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.value.trim(),
          maxDataLevel: level.value,
          snapshotRetentionDays: Number(snapshotDays.value),
          auditRetentionDays: Number(auditDays.value),
        }),
      });
      state.team = { ...state.team, ...result.team };
      const index = state.teams.findIndex((item) => item.id === state.team.id);
      if (index >= 0) state.teams[index] = { ...state.teams[index], ...result.team };
      nav.renderTeamList();
      nav.renderTeam();
      showToast('团队设置已保存');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  card.append(form);
  card.append(dataLevelGuide());
  card.append(h('p', { class: 'section-note', text: '分级上限决定哪些接口可以进入团队服务；保留天数范围 7–3650 天。' }));
  return card;
}

function dataLevelGuide() {
  const rows = ['L0', 'L1', 'L2', 'L3'].map((level) => {
    const item = dataLevels[level];
    const tone = level === 'L3' ? 'danger' : level === 'L2' ? 'restricted' : 'team';
    const policy = level === 'L3' ? '禁止同步' : level === 'L2' ? '需显式开启' : '允许同步';
    return h('div', { class: `level-row${level === 'L3' ? ' blocked' : ''}` },
      h('span', { class: 'level-tag', text: level }),
      h('div', { class: 'level-text' },
        h('strong', { text: item.label + (level === 'L1' ? '（默认）' : '') }),
        h('small', { text: item.note }),
      ),
      h('span', { class: `badge ${tone}`, text: policy }),
    );
  });
  return h('div', { class: 'level-guide' }, h('h4', { text: '数据分级说明' }), ...rows);
}

function recentAuditCard() {
  const card = h('div', { class: 'card' });
  card.append(h('div', { class: 'card-head' },
    h('h3', { text: '最近动态' }),
    h('button', { class: 'btn small', type: 'button', text: '查看全部', onclick: () => nav.switchTab('audit') }),
  ));
  if (state.audit === null) {
    card.append(h('p', { class: 'section-note', text: '当前角色不可查看审计日志。' }));
    return card;
  }
  if (!state.audit.length) {
    card.append(h('p', { class: 'section-note', text: '暂无记录。' }));
    return card;
  }
  const list = h('div', {});
  for (const entry of state.audit.slice(0, 5)) {
    list.append(h('div', { class: 'grant-row' },
      h('div', { class: 'who' },
        h('strong', { text: entry.action }),
        h('small', { text: `${fmtTime(entry.at)} · ${entry.actor?.displayName || '系统'} · ${entry.type}` }),
      ),
      h('span', { class: 'badge', text: entry.type }),
    ));
  }
  card.append(list);
  return card;
}

function renderOverview() {
  $('#tab-overview').replaceChildren(snapshotCard(), recentAuditCard());
}

function renderSettings() {
  $('#tab-settings').replaceChildren(settingsCard(state.team));
}

export { stat, restrictedCount, renderStats, kv, snapshotCard, settingsCard, dataLevelGuide, recentAuditCard, renderOverview, renderSettings };
