import { $, h, state, dataLevelText, api, showToast, isManager, codeBlock } from './core.js';
import { workspacePayload, contentCollections, contentRequests, contentCollection, contentRequest, contentDocument } from './workspace.js';
import { exportContent } from './export.js';

async function loadWorkspace() {
  if (!isManager()) {
    state.workspace = null;
    renderContent();
    return;
  }
  try {
    state.workspace = await api(`/v1/teams/${state.team.id}/workspace`);
    if (state.contentSelected) {
      const exists = state.contentSelected.type === 'collection'
        ? contentCollection(state.contentSelected.id)
        : contentRequest(state.contentSelected.id);
      if (!exists) state.contentSelected = null;
    }
    if (!state.contentSelected && workspacePayload()) {
      const first = contentCollections()[0];
      if (first) state.contentSelected = { type: 'collection', id: first.id };
    }
  } catch (error) {
    state.workspace = null;
    showToast(error.message, 'error');
  }
  renderContent();
}

function selectContent(type, id) {
  state.contentSelected = { type, id };
  renderContent();
}

function renderContent() {
  const container = $('#tab-content');
  if (!isManager()) {
    container.replaceChildren(h('div', { class: 'card' },
      h('h3', { text: '接口内容' }),
      h('p', { class: 'section-note', text: '只有团队所有者或管理员可以查看完整接口内容。' }),
    ));
    return;
  }

  const head = h('div', { class: 'card-head' },
    h('h3', { text: '接口内容与文档' }),
    h('div', { class: 'actions' },
      h('span', { class: 'muted', text: state.workspace ? `快照 #${state.workspace.revision}` : '' }),
      h('button', { class: 'btn small', type: 'button', text: '刷新', onclick: loadWorkspace }),
    ),
  );

  if (!state.workspace) {
    container.replaceChildren(h('div', { class: 'card' }, head,
      h('p', { class: 'section-note', text: '正在加载接口内容…' }),
    ));
    return;
  }

  if (!workspacePayload()) {
    container.replaceChildren(h('div', { class: 'card' }, head,
      h('p', { class: 'section-note', text: '团队还没有快照，客户端推送后即可查看接口内容。' }),
    ));
    return;
  }

  const collections = contentCollections();
  const requests = contentRequests();
  const grouped = new Map();
  for (const request of requests) {
    const key = request.collectionId || '';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(request);
  }

  const treeItems = [];
  const treeGroups = [];

  for (const collection of collections) {
    const children = grouped.get(collection.id) || [];
    const active = state.contentSelected
      && state.contentSelected.type === 'collection'
      && state.contentSelected.id === collection.id;
    const group = h('div', { class: 'tree-group' },
      h('button', {
        class: `tree-item${active ? ' active' : ''}`,
        type: 'button',
        onclick: () => selectContent('collection', collection.id),
      },
        h('span', { class: 'name', text: collection.name }),
        h('span', { class: 'count', text: `${children.length}` }),
      ),
    );
    if (children.length) {
      const childBox = h('div', { class: 'tree-children' });
      for (const request of children) {
        const childActive = state.contentSelected
          && state.contentSelected.type === 'request'
          && state.contentSelected.id === request.id;
        childBox.append(h('button', {
          class: `tree-item tree-child${childActive ? ' active' : ''}`,
          type: 'button',
          onclick: () => selectContent('request', request.id),
        },
          h('span', { class: `method ${request.method || 'GET'}`, text: request.method || 'GET' }),
          h('span', { class: 'name', text: request.name || '未命名接口' }),
        ));
      }
      group.append(childBox);
    }
    treeItems.push(group);
    treeGroups.push(group);
  }

  const ungrouped = grouped.get('') || [];
  if (ungrouped.length) {
    const group = h('div', { class: 'tree-group' },
      h('div', { class: 'tree-item' }, h('span', { class: 'name muted', text: '未分组接口' })),
    );
    const childBox = h('div', { class: 'tree-children' });
    for (const request of ungrouped) {
      const childActive = state.contentSelected
        && state.contentSelected.type === 'request'
        && state.contentSelected.id === request.id;
      childBox.append(h('button', {
        class: `tree-item tree-child${childActive ? ' active' : ''}`,
        type: 'button',
        onclick: () => selectContent('request', request.id),
      },
        h('span', { class: `method ${request.method || 'GET'}`, text: request.method || 'GET' }),
        h('span', { class: 'name', text: request.name || '未命名接口' }),
      ));
    }
    group.append(childBox);
    treeItems.push(group);
    treeGroups.push(group);
  }

  const treeSearch = h('input', { placeholder: '搜索集合或接口…' });
  treeSearch.addEventListener('input', () => {
    const keyword = treeSearch.value.trim().toLowerCase();
    for (const group of treeGroups) {
      let visible = false;
      group.querySelectorAll('.tree-item').forEach((item) => {
        const text = (item.querySelector('.name')?.textContent || '').toLowerCase();
        const matched = !keyword || text.includes(keyword);
        item.classList.toggle('hidden', !matched && item.classList.contains('tree-child'));
        if (matched) visible = true;
      });
      const parent = group.querySelector('.tree-item:not(.tree-child)');
      if (parent) {
        const parentText = (parent.querySelector('.name')?.textContent || '').toLowerCase();
        const parentMatched = !keyword || parentText.includes(keyword);
        parent.classList.toggle('hidden', !parentMatched && !visible);
      }
      group.classList.toggle('hidden', !visible && !group.querySelector('.tree-item:not(.hidden):not(.tree-child)'));
    }
  });

  const treePane = h('div', { class: 'tree-pane' },
    h('div', { class: 'tree-toolbar' }, treeSearch),
    h('div', { class: 'tree-scroll' }, ...treeItems),
  );

  const layout = h('div', { class: 'content-layout' }, treePane, renderContentDetail());
  container.replaceChildren(h('div', { class: 'card' },
    head,
    h('p', { class: 'section-note', text: '查看接口请求头、请求体与字段文档，并可按 Markdown / HTML / JSON 导出。' }),
    layout,
  ));
}

function renderContentDetail() {
  if (!state.contentSelected) {
    return h('div', { class: 'detail-pane' },
      h('h3', { text: '选择左侧接口' }),
      h('p', { class: 'detail-sub', text: '可以查看接口详情、字段文档，并导出单个接口或整个集合。' }),
    );
  }

  if (state.contentSelected.type === 'collection') {
    const collection = contentCollection(state.contentSelected.id);
    if (!collection) {
      return h('div', { class: 'detail-pane' }, h('p', { class: 'section-note', text: '集合已被删除，请刷新。' }));
    }
    const requests = contentRequests().filter(
      (request) => (request.collectionId || '') === collection.id,
    );
    const list = h('div', { class: 'detail-section' },
      h('h4', { text: '接口列表' }),
      ...(requests.length
        ? requests.map((request) => h('button', {
            class: 'content-request',
            type: 'button',
            onclick: () => selectContent('request', request.id),
          },
            h('span', { class: `method ${request.method || 'GET'}`, text: request.method || 'GET' }),
            h('span', { class: 'name', text: request.name || '未命名接口' }),
            h('span', { class: 'badge', text: dataLevelText(request.dataLevel || 'L1') }),
          ))
        : [h('p', { class: 'section-note', text: '集合中还没有接口。' })]),
    );

    return h('div', { class: 'detail-pane' },
      h('h3', { text: collection.name }),
      h('p', { class: 'detail-sub', text: `集合 · ${requests.length} 个接口` }),
      list,
      exportBar('collection', collection.id),
    );
  }

  const request = contentRequest(state.contentSelected.id);
  if (!request) {
    return h('div', { class: 'detail-pane' }, h('p', { class: 'section-note', text: '接口已被删除，请刷新。' }));
  }

  const collection = contentCollection(request.collectionId || '');
  const headers = Array.isArray(request.headers) ? request.headers : [];
  const docs = contentDocument(request.id);

  const meta = h('div', { class: 'detail-meta' },
    h('div', {}, h('label', { text: '方法' }), h('strong', { text: request.method || 'GET' })),
    h('div', {}, h('label', { text: '所属集合' }), h('strong', { text: collection ? collection.name : '未分组' })),
    h('div', {}, h('label', { text: '数据分级' }), h('strong', { text: dataLevelText(request.dataLevel || 'L1') })),
  );

  const pathBlock = h('div', { class: 'detail-section' },
    h('h4', { text: '请求路径' }),
    h('pre', { class: 'code-block', text: request.url || request.path || '-' }),
  );

  const headerBlock = h('div', { class: 'detail-section' },
    h('h4', { text: '请求头' }),
    headers.length
      ? h('div', { class: 'table-wrap' },
          h('table', { class: 'doc-table' },
            h('thead', {}, h('tr', {}, h('th', { text: '名称' }), h('th', { text: '值' }))),
            h('tbody', {}, ...headers.map((header) => h('tr', {},
              h('td', {}, h('code', { text: header.name || '' })),
              h('td', { text: header.value || '' }),
            ))),
          ),
        )
      : h('p', { class: 'section-note', text: '未配置请求头。' }),
  );

  const bodyBlock = h('div', { class: 'detail-section' },
    h('h4', { text: '请求体' }),
    request.body
      ? codeBlock(request.body)
      : h('p', { class: 'section-note', text: '无请求体。' }),
  );

  const docBlock = h('div', { class: 'detail-section' },
    h('h4', { text: `字段说明 · ${docs.length} 项` }),
    docs.length
      ? h('div', { class: 'table-wrap' },
          h('table', { class: 'doc-table' },
            h('thead', {}, h('tr', {},
              ...['字段', '路径', '类型', '来源', '说明'].map((text) => h('th', { text })),
            )),
            h('tbody', {}, ...docs.map((field) => h('tr', {},
              h('td', {}, h('strong', { text: field.key || '-' })),
              h('td', {}, h('code', { text: field.path || '-' })),
              h('td', { text: field.type || '-' }),
              h('td', { text: field.source || '-' }),
              h('td', { text: field.description || '-' }),
            ))),
          ),
        )
      : h('p', { class: 'section-note', text: '暂无字段说明。' }),
  );

  return h('div', { class: 'detail-pane' },
    h('h3', { text: request.name || '未命名接口' }),
    h('p', { class: 'detail-sub', text: '接口详情与字段文档' }),
    meta,
    pathBlock,
    headerBlock,
    bodyBlock,
    docBlock,
    exportBar('request', request.id),
  );
}

function exportBar(type, id) {
  const select = h('select', {},
    ...[['markdown', 'Markdown'], ['html', 'HTML'], ['json', 'JSON']].map(([value, label]) =>
      h('option', { value, text: label, selected: state.exportFormat === value }),
    ),
  );
  select.addEventListener('change', () => { state.exportFormat = select.value; });

  const actions = [
    h('button', {
      class: 'btn primary small',
      type: 'button',
      text: type === 'collection' ? '导出集合' : '导出接口文档',
      onclick: () => exportContent(type, id, select.value),
    }),
  ];

  if (type === 'request') {
    const request = contentRequest(id);
    const collectionId = request?.collectionId;
    if (collectionId && contentCollection(collectionId)) {
      actions.push(h('button', {
        class: 'btn small',
        type: 'button',
        text: '导出所属集合',
        onclick: () => exportContent('collection', collectionId, select.value),
      }));
    }
  }

  return h('div', { class: 'export-bar' },
    h('span', { class: 'muted', text: '导出格式' }),
    select,
    ...actions,
    h('span', { class: 'spacer' }),
    h('span', { class: 'muted', text: '包含接口信息、请求头、请求体与字段文档' }),
  );
}

export { loadWorkspace, selectContent, renderContent, renderContentDetail, exportBar };
