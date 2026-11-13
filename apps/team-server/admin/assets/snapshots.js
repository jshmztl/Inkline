import { $, h, state, api, authorizedFetch, showToast, fmtTime, fmtBytes, shortHash, isManager, payloadDialog, payloadBody, payloadTitle, nav } from './core.js';
import { openDiff } from './diff.js';

function renderSnapshots() {
  const container = $('#tab-snapshots');
  const card = h('div', { class: 'card' });
  card.append(h('div', { class: 'card-head' },
    h('h3', { text: '快照历史' }),
    h('span', { class: 'muted', text: state.history.length ? `已加载 ${state.history.length} 条` : '' }),
  ));

  if (!state.history.length) {
    card.append(h('p', { class: 'section-note', text: '暂无快照。' }));
    container.replaceChildren(card);
    return;
  }

  if (state.history.length >= 2) {
    const revisions = state.history.map((entry) => entry.revision).sort((left, right) => left - right);
    const fromSelect = h('select', {},
      ...revisions.map((revision) => h('option', {
        value: String(revision),
        text: '#' + revision,
        selected: revision === revisions[revisions.length - 2],
      })),
    );
    const toSelect = h('select', {},
      ...revisions.map((revision) => h('option', {
        value: String(revision),
        text: '#' + revision,
        selected: revision === revisions[revisions.length - 1],
      })),
    );
    card.append(h('div', { class: 'diff-toolbar' },
      h('span', { class: 'muted', text: '版本对比' }),
      fromSelect,
      h('span', { class: 'muted', text: '→' }),
      toSelect,
      h('button', {
        class: 'btn primary small',
        type: 'button',
        text: '对比',
        onclick: () => openDiff(Number(fromSelect.value), Number(toSelect.value)),
      }),
    ));
  }

  const rows = state.history.map((entry) => {
    const view = h('button', { class: 'btn small', type: 'button', text: '查看' });
    view.addEventListener('click', () => openPayload(entry.revision));
    const download = h('button', { class: 'btn small', type: 'button', text: '下载' });
    download.addEventListener('click', () => downloadSnapshot(entry.revision));
    const diff = h('button', { class: 'btn small', type: 'button', text: '对比上一版' });
    diff.addEventListener('click', () => openDiff(entry.revision - 1, entry.revision));
    const rollback = isManager() && entry.revision !== state.latest?.revision
      ? h('button', { class: 'btn small', type: 'button', text: '回滚' })
      : null;
    if (rollback) rollback.addEventListener('click', () => rollbackSnapshot(entry.revision));
    return h('tr', {},
      h('td', {}, h('strong', { text: '#' + entry.revision })),
      h('td', { text: fmtTime(entry.createdAt) }),
      h('td', { text: entry.createdBy?.displayName || '-' }),
      h('td', { text: fmtBytes(entry.sizeBytes) }),
      h('td', { text: entry.baseRevision === null || entry.baseRevision === undefined ? '-' : '#' + entry.baseRevision }),
      h('td', {}, h('code', { text: shortHash(entry.hash) })),
      h('td', {}, h('div', { class: 'actions' }, view, download, entry.revision > 1 ? diff : null, rollback)),
    );
  });

  const table = h('div', { class: 'table-wrap' },
    h('table', { class: 'table' },
      h('thead', {}, h('tr', {},
        ...['版本', '时间', '上传者', '大小', '基础版本', 'Hash', '操作'].map((text) => h('th', { text })),
      )),
      h('tbody', {}, ...rows),
    ),
  );
  card.append(table);

  if (state.historyCursor) {
    const more = h('button', { class: 'btn', type: 'button', text: '加载更多' });
    more.addEventListener('click', loadMoreHistory);
    card.append(h('div', { class: 'actions', style: 'margin-top:12px' }, more));
  }
  container.replaceChildren(card);
}

async function loadMoreHistory() {
  try {
    const page = await api(`/v1/teams/${state.team.id}/snapshots?limit=20&before=${state.historyCursor}`);
    state.history = state.history.concat(page.entries || []);
    state.historyCursor = page.nextCursor;
    renderSnapshots();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function openPayload(revision) {
  try {
    const payload = await api(`/v1/teams/${state.team.id}/snapshots/${revision}`);
    payloadTitle.textContent = `快照 #${revision}`;
    payloadBody.textContent = JSON.stringify(payload, null, 2).slice(0, 500000);
    payloadDialog.showModal();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function downloadSnapshot(revision) {
  try {
    const response = await authorizedFetch(`/v1/teams/${state.team.id}/snapshots/${revision}`);
    if (!response.ok) throw new Error('下载失败');
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `inkline-${state.team.name}-r${revision}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function rollbackSnapshot(revision) {
  if (!confirm(`确定把快照 #${revision} 回滚为最新版本吗？回滚会生成一个新版本，历史记录不会删除。`)) return;
  try {
    const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result = await api(`/v1/teams/${state.team.id}/snapshots/${revision}/rollback`, {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
    });
    showToast(`已回滚到 #${revision}，生成新版本 #${result.revision}`);
    await nav.selectTeam(state.team.id);
    nav.switchTab('snapshots');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

export { renderSnapshots, loadMoreHistory, openPayload, downloadSnapshot, rollbackSnapshot };
