import { $, h, state, roleLabels, dataLevelText, api, showToast, isManager, nav } from './core.js';
import { restrictedCount, renderStats } from './overview.js';

// ---------------- 权限 ----------------

function grantMap(grants) {
  const map = new Map();
  for (const grant of grants || []) {
    map.set(`${grant.subjectType}:${grant.subjectId}`, grant.permission);
  }
  return map;
}

function permissionResource(type, id) {
  if (!state.permission) return null;
  if (type === 'collection') {
    return state.permission.collections.find((item) => item.id === id) || null;
  }
  return state.permission.requests.find((item) => item.id === id) || null;
}

function selectPermission(type, id) {
  const resource = permissionResource(type, id);
  if (!resource) return;
  state.permSelected = { type, id };
  state.permDraft = {
    visibility: resource.visibility === 'inherit' ? 'inherit' : resource.visibility,
    grants: grantMap(resource.grants),
  };
  state.permApplyAll = false;
  renderPermissions();
}

function badgeFor(resource) {
  if (resource.visibility === 'inherit') return h('span', { class: 'badge inherit', text: '继承集合' });
  if (resource.visibility === 'team') return h('span', { class: 'badge team', text: '团队可见' });
  const count = (resource.grants || []).length;
  return h('span', { class: 'badge restricted', text: count ? `受限 ${count}` : '受限' });
}

function renderPermissions() {
  const container = $('#tab-permissions');
  if (!isManager()) {
    container.replaceChildren(h('div', { class: 'card' },
      h('h3', { text: '资源权限' }),
      h('p', { class: 'section-note', text: '只有团队所有者或管理员可以配置资源权限。' }),
    ));
    return;
  }
  if (!state.permission) {
    const card = h('div', { class: 'card' });
    card.append(h('h3', { text: '资源权限' }));
    card.append(h('p', { class: 'section-note', text: '团队还没有快照，推送一次后才能配置接口与集合的可见范围。' }));
    container.replaceChildren(card);
    return;
  }

  const collectionRequests = new Map();
  for (const request of state.permission.requests) {
    const key = request.collectionId || '';
    if (!collectionRequests.has(key)) collectionRequests.set(key, []);
    collectionRequests.get(key).push(request);
  }

  const treeItems = [];
  const search = '';
  for (const collection of state.permission.collections) {
    const children = collectionRequests.get(collection.id) || [];
    const active = state.permSelected && state.permSelected.type === 'collection' && state.permSelected.id === collection.id;
    const group = h('div', { class: 'tree-group' },
      h('button', {
        class: `tree-item${active ? ' active' : ''}`,
        type: 'button',
        onclick: () => selectPermission('collection', collection.id),
      },
        h('span', { class: 'name', text: collection.name }),
        h('span', { class: 'count', text: `${collection.requestCount}` }),
        badgeFor(collection),
      ),
    );
    if (children.length) {
      const childBox = h('div', { class: 'tree-children' });
      for (const request of children) {
        const childActive = state.permSelected && state.permSelected.type === 'request' && state.permSelected.id === request.id;
        childBox.append(h('button', {
          class: `tree-item tree-child${childActive ? ' active' : ''}`,
          type: 'button',
          onclick: () => selectPermission('request', request.id),
        },
          h('span', { class: `method ${request.method}`, text: request.method }),
          h('span', { class: 'name', text: request.name }),
          badgeFor(request),
        ));
      }
      group.append(childBox);
    }
    treeItems.push(group);
  }

  const ungrouped = collectionRequests.get('') || [];
  if (ungrouped.length) {
    const group = h('div', { class: 'tree-group' }, h('div', { class: 'tree-item' }, h('span', { class: 'name muted', text: '未分组接口' })));
    const childBox = h('div', { class: 'tree-children' });
    for (const request of ungrouped) {
      const childActive = state.permSelected && state.permSelected.type === 'request' && state.permSelected.id === request.id;
      childBox.append(h('button', {
        class: `tree-item tree-child${childActive ? ' active' : ''}`,
        type: 'button',
        onclick: () => selectPermission('request', request.id),
      },
        h('span', { class: `method ${request.method}`, text: request.method }),
        h('span', { class: 'name', text: request.name }),
        badgeFor(request),
      ));
    }
    group.append(childBox);
    treeItems.push(group);
  }

  const treeSearch = h('input', { placeholder: '搜索集合或接口…' });
  treeSearch.addEventListener('input', () => {
    const keyword = treeSearch.value.trim().toLowerCase();
    for (const group of treeItems) {
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

  const layout = h('div', { class: 'perm-layout' }, treePane, renderPermissionEditor());
  container.replaceChildren(h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', { text: '接口与文档权限' }),
      h('div', { class: 'actions' },
        h('button', { class: 'btn small', type: 'button', text: '刷新', onclick: loadPermissions }),
      ),
    ),
    h('p', { class: 'section-note', text: `受限资源只对指定成员可见，所有者与管理员始终可见。当前快照 #${state.permission.revision}。` }),
    layout,
  ));
}

function renderPermissionEditor() {
  if (!state.permSelected || !state.permDraft) {
    return h('div', { class: 'perm-editor' },
      h('h3', { text: '选择左侧资源' }),
      h('p', { class: 'perm-sub', text: '可以先选集合做整体授权，再对单个接口覆盖。' }),
      h('div', { class: 'summary-line' },
        h('span', { class: 'badge team', text: `集合 ${state.permission.collections.length}` }),
        h('span', { class: 'badge', text: `接口 ${state.permission.requests.length}` }),
        h('span', { class: 'badge restricted', text: `受限 ${restrictedCount()}` }),
      ),
    );
  }

  const resource = permissionResource(state.permSelected.type, state.permSelected.id);
  if (!resource) {
    return h('div', { class: 'perm-editor' }, h('p', { class: 'section-note', text: '资源已被删除，请刷新。' }));
  }
  const isCollection = state.permSelected.type === 'collection';
  const visibility = state.permDraft.visibility;

  const header = h('div', {},
    h('h3', { text: resource.name }),
    h('p', { class: 'perm-sub', text: isCollection ? '集合级权限会作用于其下接口，单接口可覆盖。' : `${resource.method} · 数据分级 ${dataLevelText(resource.dataLevel)} · ${resource.hasDocument ? '含文档' : '无文档'}` }),
  );

  const options = [];
  if (!isCollection) {
    options.push(h('label', { class: `vis-option${visibility === 'inherit' ? ' active' : ''}` },
      h('input', { type: 'radio', name: 'visibility', value: 'inherit', checked: visibility === 'inherit', onchange: () => setVisibility('inherit') }),
      h('div', {}, h('strong', { text: '跟随集合' }), h('small', { text: '不单独设置，完全继承所属集合的可见范围。' })),
    ));
  }
  options.push(h('label', { class: `vis-option${visibility === 'team' ? ' active' : ''}` },
    h('input', { type: 'radio', name: 'visibility', value: 'team', checked: visibility === 'team', onchange: () => setVisibility('team') }),
    h('div', {}, h('strong', { text: '团队可见' }), h('small', { text: '所有团队成员都可以查看；成员可编辑，只读成员仅查看。' })),
  ));
  options.push(h('label', { class: `vis-option${visibility === 'restricted' ? ' active' : ''}` },
    h('input', { type: 'radio', name: 'visibility', value: 'restricted', checked: visibility === 'restricted', onchange: () => setVisibility('restricted') }),
    h('div', {}, h('strong', { text: '仅指定成员' }), h('small', { text: '只有被授权的成员或角色可以看到，其他成员完全不可见。' })),
  ));

  const editor = h('div', { class: 'perm-editor' }, header, h('div', { class: 'vis-options' }, ...options));

  if (visibility === 'restricted') {
    editor.append(renderGrantSection());
  }

  const footer = h('div', { class: 'perm-footer' });
  if (isCollection) {
    const check = h('input', { type: 'checkbox', checked: state.permApplyAll });
    check.addEventListener('change', () => { state.permApplyAll = check.checked; });
    footer.append(h('label', { class: 'checkline' }, check, `同时应用到集合内 ${resource.requestCount} 个接口`));
  }
  footer.append(h('span', { class: 'spacer' }));
  if (!isCollection) {
    footer.append(h('button', {
      class: 'btn small', type: 'button', text: '恢复继承',
      onclick: () => savePermission('inherit'),
    }));
  }
  footer.append(h('button', {
    class: 'btn primary', type: 'button', text: '保存权限',
    onclick: () => savePermission(state.permDraft.visibility),
  }));
  editor.append(footer);
  return editor;
}

function renderGrantSection() {
  const draft = state.permDraft;
  const section = h('div', { class: 'grant-section' },
    h('h4', { text: '授权范围' }),
    h('p', { class: 'section-note', text: '按角色授权会覆盖后续新加入的成员；单个成员授权可用于例外调整。' }),
  );

  const roleMember = draft.grants.get('role:member') || 'none';
  const roleViewer = draft.grants.get('role:viewer') || 'none';

  const roleRow = (role, value) => {
    const select = h('select', {},
      h('option', { value: 'none', text: '不可见', selected: value === 'none' }),
      h('option', { value: 'view', text: '可查看', selected: value === 'view' }),
      role === 'member' ? h('option', { value: 'edit', text: '可编辑', selected: value === 'edit' }) : null,
    );
    select.addEventListener('change', () => {
      if (select.value === 'none') draft.grants.delete('role:' + role);
      else draft.grants.set('role:' + role, select.value);
    });
    return h('div', { class: 'grant-row' },
      h('div', { class: 'who' },
        h('strong', { text: role === 'member' ? '所有成员' : '所有只读成员' }),
        h('small', { text: role === 'member' ? '角色为“成员”的账号' : '角色为“只读”的账号' }),
      ),
      select,
    );
  };

  section.append(h('div', { class: 'grant-toolbar' },
    h('button', {
      class: 'btn small', type: 'button', text: '全部成员可查看',
      onclick: () => {
        draft.grants.set('role:member', 'view');
        draft.grants.set('role:viewer', 'view');
        refreshPermissionEditor();
      },
    }),
    h('button', {
      class: 'btn small', type: 'button', text: '清空授权',
      onclick: () => { draft.grants.clear(); refreshPermissionEditor(); },
    }),
  ));
  section.append(roleRow('member', roleMember), roleRow('viewer', roleViewer));

  const memberSearch = h('input', { placeholder: '搜索成员…', style: 'height:32px;border:1px solid var(--line);border-radius:8px;padding:0 9px;width:180px' });
  const memberRows = [];
  const manageable = state.members.filter((member) => member.role === 'member' || member.role === 'viewer');
  for (const member of manageable) {
    const key = `user:${member.userId}`;
    const value = draft.grants.get(key) || 'none';
    const select = h('select', {},
      h('option', { value: 'none', text: '不可见', selected: value === 'none' }),
      h('option', { value: 'view', text: '可查看', selected: value === 'view' }),
      member.role === 'member' ? h('option', { value: 'edit', text: '可编辑', selected: value === 'edit' }) : null,
    );
    select.addEventListener('change', () => {
      if (select.value === 'none') draft.grants.delete(key);
      else draft.grants.set(key, select.value);
    });
    const row = h('div', { class: 'grant-row' },
      h('div', { class: 'who' },
        h('strong', { text: member.displayName }),
        h('small', { text: `${member.account} · ${roleLabels[member.role]}` }),
      ),
      select,
    );
    row.dataset.search = `${member.displayName} ${member.account}`.toLowerCase();
    memberRows.push(row);
  }

  memberSearch.addEventListener('input', () => {
    const keyword = memberSearch.value.trim().toLowerCase();
    for (const row of memberRows) row.classList.toggle('hidden', !!keyword && !row.dataset.search.includes(keyword));
  });

  section.append(h('div', { class: 'grant-section' },
    h('h4', { text: '指定成员' }),
    h('p', { class: 'section-note', text: '所有者与管理员始终可见，不需要单独授权。' }),
    h('div', { class: 'grant-toolbar' }, memberSearch),
    ...(memberRows.length ? memberRows : [h('p', { class: 'section-note', text: '团队中还没有成员或只读账号。' })]),
  ));
  return section;
}

function refreshPermissionEditor() {
  const editor = $('.perm-editor');
  if (!editor) return;
  const parent = editor.parentElement;
  const fresh = renderPermissionEditor();
  parent.replaceChild(fresh, editor);
}

function setVisibility(value) {
  state.permDraft.visibility = value;
  renderPermissions();
}

function draftGrants() {
  const grants = [];
  for (const [key, permission] of state.permDraft.grants) {
    const index = key.indexOf(':');
    grants.push({
      subjectType: key.slice(0, index),
      subjectId: key.slice(index + 1),
      permission,
    });
  }
  return grants;
}

async function savePermission(explicitVisibility) {
  if (!state.permSelected) return;
  const visibility = explicitVisibility || state.permDraft.visibility;
  const isCollection = state.permSelected.type === 'collection';
  try {
    if (visibility === 'inherit') {
      await api(`/v1/teams/${state.team.id}/permissions/request/${state.permSelected.id}`, { method: 'DELETE' });
      showToast('已恢复继承集合权限');
    } else if (isCollection && state.permApplyAll) {
      const requests = state.permission.requests.filter((item) => item.collectionId === state.permSelected.id);
      const grants = visibility === 'restricted' ? draftGrants() : [];
      if (!requests.length) {
        await api(`/v1/teams/${state.team.id}/permissions/collection/${state.permSelected.id}`, {
          method: 'PUT',
          body: JSON.stringify({ visibility, grants }),
        });
      } else {
        const items = requests.map((request) => ({
          resourceType: 'request',
          resourceId: request.id,
          visibility,
          grants,
        }));
        items.push({
          resourceType: 'collection',
          resourceId: state.permSelected.id,
          visibility,
          grants,
        });
        await api(`/v1/teams/${state.team.id}/permissions/batch`, {
          method: 'POST',
          body: JSON.stringify({ items }),
        });
      }
      showToast(`已应用到集合与 ${requests.length} 个接口`);
    } else {
      const grants = visibility === 'restricted' ? draftGrants() : [];
      await api(`/v1/teams/${state.team.id}/permissions/${state.permSelected.type}/${state.permSelected.id}`, {
        method: 'PUT',
        body: JSON.stringify({ visibility, grants }),
      });
      showToast('权限已保存');
    }
    await loadPermissions();
    nav.renderTeamList();
    renderStats(state.team);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function loadPermissions() {
  if (!isManager()) {
    state.permission = null;
    renderPermissions();
    return;
  }
  try {
    state.permission = await api(`/v1/teams/${state.team.id}/permissions`);
    if (state.permSelected) {
      const still = permissionResource(state.permSelected.type, state.permSelected.id);
      if (!still) {
        state.permSelected = null;
        state.permDraft = null;
      } else {
        state.permDraft = {
          visibility: still.visibility === 'inherit' ? 'inherit' : still.visibility,
          grants: grantMap(still.grants),
        };
      }
    }
  } catch (error) {
    state.permission = null;
    if (error.status !== 404) showToast(error.message, 'error');
  }
  renderPermissions();
  renderStats(state.team);
}

export { grantMap, permissionResource, selectPermission, badgeFor, renderPermissions, renderPermissionEditor, renderGrantSection, refreshPermissionEditor, setVisibility, draftGrants, savePermission, loadPermissions };
