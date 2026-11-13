import { $, h, state, diffDialog, diffTitle, diffBody, diffSummary, diffOutline, diffNavPos, diffState, showToast, api, dataLevelText, paintJson } from './core.js';

// ---------------- 快照 / 审计 ----------------

function collectionName(payload, id) {
  const collection = (payload?.collections || []).find((item) => item.id === id);
  return collection ? collection.name : (id || '未分组');
}

function buildSnapshotDiff(before, after) {
  const beforeCollections = new Map((before.collections || []).map((item) => [item.id, item]));
  const afterCollections = new Map((after.collections || []).map((item) => [item.id, item]));
  const beforeRequests = new Map((before.requests || []).map((item) => [item.id, item]));
  const afterRequests = new Map((after.requests || []).map((item) => [item.id, item]));
  const beforeDocuments = before.documents || {};
  const afterDocuments = after.documents || {};

  const collectionDiff = { added: [], removed: [], changed: [] };
  for (const [id, item] of afterCollections) {
    if (!beforeCollections.has(id)) collectionDiff.added.push({ name: item.name || id });
  }
  for (const [id, item] of beforeCollections) {
    if (!afterCollections.has(id)) collectionDiff.removed.push({ name: item.name || id });
  }
  for (const [id, item] of afterCollections) {
    const previous = beforeCollections.get(id);
    if (!previous) continue;
    if (previous.name !== item.name || (previous.sort ?? 0) !== (item.sort ?? 0)) {
      collectionDiff.changed.push({
        name: item.name || id,
        fields: [
          previous.name !== item.name ? { label: '名称', before: previous.name || '', after: item.name || '' } : null,
          (previous.sort ?? 0) !== (item.sort ?? 0)
            ? { label: '排序', before: String(previous.sort ?? 0), after: String(item.sort ?? 0) }
            : null,
        ].filter(Boolean),
      });
    }
  }

  const requestDiff = { added: [], removed: [], changed: [] };
  for (const [id, item] of afterRequests) {
    if (!beforeRequests.has(id)) {
      requestDiff.added.push({ name: item.name || id, method: item.method || 'GET' });
    }
  }
  for (const [id, item] of beforeRequests) {
    if (!afterRequests.has(id)) {
      requestDiff.removed.push({ name: item.name || id, method: item.method || 'GET' });
    }
  }
  for (const [id, item] of afterRequests) {
    const previous = beforeRequests.get(id);
    if (!previous) continue;
    const fields = [];
    const compare = (label, beforeValue, afterValue) => {
      const beforeText = String(beforeValue ?? '');
      const afterText = String(afterValue ?? '');
      if (beforeText !== afterText) fields.push({ label, before: beforeText, after: afterText });
    };
    compare('名称', previous.name, item.name);
    compare('方法', previous.method, item.method);
    compare('路径', previous.url ?? previous.path, item.url ?? item.path);
    compare('数据分级', previous.dataLevel, item.dataLevel);
    compare(
      '所属集合',
      collectionName(before, previous.collectionId),
      collectionName(after, item.collectionId),
    );
    compare('请求头', JSON.stringify(previous.headers || []), JSON.stringify(item.headers || []));
    compare('请求体', previous.body || '', item.body || '');
    if (fields.length) {
      requestDiff.changed.push({ name: item.name || id, method: item.method || 'GET', fields });
    }
  }

  const documentDiff = { added: [], removed: [], changed: [] };
  const documentIds = new Set([...Object.keys(beforeDocuments), ...Object.keys(afterDocuments)]);
  for (const requestId of documentIds) {
    const beforeFields = Array.isArray(beforeDocuments[requestId]) ? beforeDocuments[requestId] : [];
    const afterFields = Array.isArray(afterDocuments[requestId]) ? afterDocuments[requestId] : [];
    if (!beforeFields.length && afterFields.length) {
      documentDiff.added.push({
        name: afterRequests.get(requestId)?.name || requestId,
        fields: afterFields.map((field) => field.key || field.path || '-'),
      });
      continue;
    }
    if (beforeFields.length && !afterFields.length) {
      documentDiff.removed.push({
        name: beforeRequests.get(requestId)?.name || requestId,
        fields: beforeFields.map((field) => field.key || field.path || '-'),
      });
      continue;
    }
    const beforeMap = new Map(beforeFields.map((field, index) => [field.key || field.path || String(index), field]));
    const afterMap = new Map(afterFields.map((field, index) => [field.key || field.path || String(index), field]));
    const fields = [];
    for (const [key, field] of afterMap) {
      const previous = beforeMap.get(key);
      if (!previous) {
        fields.push({ label: key, before: '（新增）', after: field.description || field.type || '' });
        continue;
      }
      const changed = previous.description !== field.description
        || previous.type !== field.type
        || previous.path !== field.path
        || previous.source !== field.source;
      if (changed) {
        fields.push({
          label: key,
          before: previous.description || '',
          after: field.description || '',
        });
      }
    }
    for (const [key, field] of beforeMap) {
      if (!afterMap.has(key)) {
        fields.push({ label: key, before: field.description || '', after: '（已删除）' });
      }
    }
    if (fields.length) {
      documentDiff.changed.push({
        name: afterRequests.get(requestId)?.name || beforeRequests.get(requestId)?.name || requestId,
        fields,
      });
    }
  }

  return { collectionDiff, requestDiff, documentDiff };
}

function diffSection(title, entries, renderEntry) {
  if (!entries.length) return null;
  return h('div', { class: 'diff-section' },
    h('h4', { text: `${title} · ${entries.length}` }),
    ...entries.map(renderEntry),
  );
}

function renderDiff(diff, fromRevision, toRevision) {
  diffTitle.textContent = `版本对比 · #${fromRevision} → #${toRevision}`;
  const { collectionDiff, requestDiff, documentDiff } = diff;
  const total =
    collectionDiff.added.length + collectionDiff.removed.length + collectionDiff.changed.length +
    requestDiff.added.length + requestDiff.removed.length + requestDiff.changed.length +
    documentDiff.added.length + documentDiff.removed.length + documentDiff.changed.length;

  const summary = h('div', { class: 'summary-line' },
    h('span', { class: 'badge team', text: `接口 +${requestDiff.added.length} / -${requestDiff.removed.length} / 改 ${requestDiff.changed.length}` }),
    h('span', { class: 'badge', text: `集合 +${collectionDiff.added.length} / -${collectionDiff.removed.length} / 改 ${collectionDiff.changed.length}` }),
    h('span', { class: 'badge restricted', text: `文档 +${documentDiff.added.length} / -${documentDiff.removed.length} / 改 ${documentDiff.changed.length}` }),
  );

  if (total === 0) {
    diffBody.replaceChildren(summary, h('p', { class: 'section-note', text: '两个版本的集合、接口与字段文档内容一致。' }));
    diffDialog.showModal();
    return;
  }

  const simpleEntry = (tag, tone) => (item) => h('div', { class: 'diff-item' },
    h('span', { class: `diff-tag ${tone}`, text: tag }),
    h('span', { class: 'diff-name', text: `${item.method ? `${item.method} ` : ''}${item.name}` }),
  );

  const changedEntry = (item) => h('div', {},
    h('div', { class: 'diff-item' },
      h('span', { class: 'diff-tag change', text: '修改' }),
      h('span', { class: 'diff-name', text: `${item.method ? `${item.method} ` : ''}${item.name}` }),
    ),
    ...item.fields.map((field) => h('div', { class: 'diff-field' },
      h('span', { class: 'diff-field-name', text: field.label }),
      h('span', { class: 'diff-before', text: field.before || '（空）' }),
      h('span', { text: ' → ' }),
      h('span', { class: 'diff-after', text: field.after || '（空）' }),
    )),
  );

  const documentEntry = (tag, tone) => (item) => h('div', { class: 'diff-item' },
    h('span', { class: `diff-tag ${tone}`, text: tag }),
    h('span', { class: 'diff-name', text: `${item.name} · ${item.fields.join('、')}` }),
  );

  diffBody.replaceChildren(
    summary,
    diffSection('集合', [...collectionDiff.added.map((item) => ({ ...item, _tag: 'add' })), ...collectionDiff.removed.map((item) => ({ ...item, _tag: 'remove' })), ...collectionDiff.changed], (item) => {
      if (item._tag === 'add') return simpleEntry('新增', 'add')(item);
      if (item._tag === 'remove') return simpleEntry('删除', 'remove')(item);
      return changedEntry({ ...item, method: '' });
    }) || h('span'),
    diffSection('接口', [...requestDiff.added, ...requestDiff.removed, ...requestDiff.changed], (item) => {
      if (requestDiff.added.includes(item)) return simpleEntry('新增', 'add')(item);
      if (requestDiff.removed.includes(item)) return simpleEntry('删除', 'remove')(item);
      return changedEntry(item);
    }) || h('span'),
    diffSection('字段文档', [...documentDiff.added, ...documentDiff.removed, ...documentDiff.changed], (item) => {
      if (documentDiff.added.includes(item)) return documentEntry('新增', 'add')(item);
      if (documentDiff.removed.includes(item)) return documentEntry('删除', 'remove')(item);
      return changedEntry({ ...item, method: '' });
    }) || h('span'),
  );
  diffDialog.showModal();
}

function requestContentLines(payload, request) {
  const docs = payload?.documents?.[request.id];
  const fields = Array.isArray(docs) ? docs : [];
  const headers = Array.isArray(request.headers) ? request.headers : [];
  return [
    `${request.method || 'GET'} ${request.url ?? request.path ?? ''}`,
    `名称: ${request.name || ''}`,
    `集合: ${collectionName(payload, request.collectionId)}`,
    `数据分级: ${dataLevelText(request.dataLevel || 'L1')}`,
    '',
    '请求头:',
    ...(headers.length
      ? headers.map((header) => `  ${header.name}: ${header.value}`)
      : ['  （无）']),
    '',
    '请求体:',
    ...(request.body
      ? String(request.body).split('\n').map((line) => `  ${line}`)
      : ['  （无）']),
    '',
    '字段文档:',
    ...(fields.length
      ? fields.map((field) => `  ${field.key || '-'} | ${field.path || '-'} | ${field.type || '-'} | ${field.source || '-'} | ${field.description || '-'}`)
      : ['  （无）']),
  ];
}

function buildSideDiff(before, after) {
  const beforeCollections = new Map((before.collections || []).map((item) => [item.id, item]));
  const afterCollections = new Map((after.collections || []).map((item) => [item.id, item]));
  const collectionIds = [...new Set([...beforeCollections.keys(), ...afterCollections.keys()])];
  const collections = collectionIds.map((id) => {
    const left = beforeCollections.get(id) || null;
    const right = afterCollections.get(id) || null;
    let status = 'same';
    if (!left) status = 'add';
    else if (!right) status = 'remove';
    else if (left.name !== right.name || (left.sort ?? 0) !== (right.sort ?? 0)) {
      status = 'change';
    }
    return { id, left, right, status };
  });

  const beforeRequests = new Map((before.requests || []).map((item) => [item.id, item]));
  const afterRequests = new Map((after.requests || []).map((item) => [item.id, item]));
  const requestIds = [...new Set([...beforeRequests.keys(), ...afterRequests.keys()])];
  const requests = requestIds.map((id) => {
    const left = beforeRequests.get(id) || null;
    const right = afterRequests.get(id) || null;
    const leftBlocks = left ? requestDocBlocks(before, left) : [];
    const rightBlocks = right ? requestDocBlocks(after, right) : [];
    let status = 'same';
    if (!left) status = 'add';
    else if (!right) status = 'remove';
    else if (
      leftBlocks.map(docBlockSignature).join('\u0000')
      !== rightBlocks.map(docBlockSignature).join('\u0000')
    ) {
      status = 'change';
    }
    return {
      id,
      left,
      right,
      leftBlocks,
      rightBlocks,
      status,
      name: right?.name ?? left?.name ?? id,
      method: right?.method ?? left?.method ?? 'GET',
    };
  });

  const count = (rows) => ({
    add: rows.filter((row) => row.status === 'add').length,
    remove: rows.filter((row) => row.status === 'remove').length,
    change: rows.filter((row) => row.status === 'change').length,
  });

  return {
    collections,
    requests,
    collectionCount: count(collections),
    requestCount: count(requests),
  };
}

function requestDocBlocks(payload, request) {
  const docs = payload?.documents?.[request.id];
  const fields = Array.isArray(docs) ? docs : [];
  const headers = Array.isArray(request.headers) ? request.headers : [];
  const blocks = [
    { type: 'title', method: request.method || 'GET', name: request.name || '未命名接口' },
    { type: 'meta', label: '方法', value: request.method || 'GET' },
    { type: 'meta', label: '路径', value: request.url ?? request.path ?? '' },
    { type: 'meta', label: '所属集合', value: collectionName(payload, request.collectionId) },
    { type: 'meta', label: '数据分级', value: dataLevelText(request.dataLevel || 'L1') },
    { type: 'heading', text: `请求头（${headers.length}）` },
  ];
  if (headers.length) {
    for (const header of headers) {
      blocks.push({ type: 'kv', label: header.name || '', value: header.value || '' });
    }
  } else {
    blocks.push({ type: 'muted', text: '未配置请求头' });
  }
  blocks.push({ type: 'heading', text: '请求体' });
  const bodyText = request.body ? String(request.body) : '';
  let bodyJson = false;
  if (bodyText.trim()) {
    try {
      JSON.parse(bodyText);
      bodyJson = true;
    } catch {
      bodyJson = false;
    }
  }
  if (bodyText) {
    for (const line of bodyText.split('\n')) {
      blocks.push({ type: 'code', text: line, json: bodyJson });
    }
  } else {
    blocks.push({ type: 'muted', text: '无请求体' });
  }
  blocks.push({ type: 'heading', text: `字段说明（${fields.length}）` });
  if (fields.length) {
    for (const field of fields) {
      blocks.push({ type: 'field', field });
    }
  } else {
    blocks.push({ type: 'muted', text: '暂无字段说明' });
  }
  return blocks;
}

function docBlockSignature(block) {
  if (!block) return '';
  if (block.type === 'field') {
    const field = block.field || {};
    return JSON.stringify([
      'field',
      field.key || '',
      field.path || '',
      field.type || '',
      field.source || '',
      field.description || '',
    ]);
  }
  return JSON.stringify([
    block.type,
    block.label || '',
    block.value || '',
    block.text || '',
    block.method || '',
    block.name || '',
  ]);
}

function computeBlockDiff(leftBlocks, rightBlocks) {
  const left = leftBlocks || [];
  const right = rightBlocks || [];
  const table = Array.from({ length: left.length + 1 }, () =>
    new Uint16Array(right.length + 1),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = docBlockSignature(left[i]) === docBlockSignature(right[j])
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (docBlockSignature(left[i]) === docBlockSignature(right[j])) {
      ops.push({ type: 'same', left: left[i], right: right[j] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: 'remove', left: left[i], right: null });
      i += 1;
    } else {
      ops.push({ type: 'add', left: null, right: right[j] });
      j += 1;
    }
  }
  while (i < left.length) {
    ops.push({ type: 'remove', left: left[i], right: null });
    i += 1;
  }
  while (j < right.length) {
    ops.push({ type: 'add', left: null, right: right[j] });
    j += 1;
  }

  const rows = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index].type === 'same') {
      rows.push(ops[index]);
      index += 1;
      continue;
    }
    const removes = [];
    const adds = [];
    while (index < ops.length && ops[index].type === 'remove') {
      removes.push(ops[index].left);
      index += 1;
    }
    while (index < ops.length && ops[index].type === 'add') {
      adds.push(ops[index].right);
      index += 1;
    }
    const size = Math.max(removes.length, adds.length);
    for (let offset = 0; offset < size; offset += 1) {
      const hasLeft = Boolean(removes[offset]);
      const hasRight = Boolean(adds[offset]);
      rows.push({
        type: hasLeft && hasRight ? 'change' : hasLeft ? 'remove' : 'add',
        left: removes[offset] || null,
        right: adds[offset] || null,
      });
    }
  }
  return rows;
}

function renderDocBlock(block) {
  if (!block) return '';
  if (block.type === 'title') {
    return h('div', { class: 'doc-title' },
      h('span', { class: `method ${block.method || 'GET'}`, text: block.method || 'GET' }),
      h('span', { text: block.name || '' }),
    );
  }
  if (block.type === 'meta') {
    return h('div', { class: 'doc-meta' },
      h('span', { text: block.label || '' }),
      h('span', { text: block.value || '' }),
    );
  }
  if (block.type === 'heading') {
    return h('div', { class: 'doc-heading', text: block.text || '' });
  }
  if (block.type === 'kv') {
    return h('div', { class: 'doc-kv' },
      h('code', { text: block.label || '' }),
      h('span', { text: block.value || '' }),
    );
  }
  if (block.type === 'code') {
    const line = h('div', { class: 'doc-code-line' });
    if (block.json && block.text) {
      paintJson(line, block.text);
    } else {
      line.textContent = block.text || ' ';
    }
    return line;
  }
  if (block.type === 'field') {
    const field = block.field || {};
    return h('div', { class: 'doc-field' },
      h('strong', { text: field.key || '-' }),
      h('code', { text: field.path || '-' }),
      h('span', { text: field.type || '-' }),
      h('span', { text: field.source || '-' }),
      h('span', { text: field.description || '-' }),
    );
  }
  return h('div', { class: 'doc-muted', text: block.text || '' });
}

function renderDocDiff(leftBlocks, rightBlocks) {
  const rows = computeBlockDiff(leftBlocks, rightBlocks);
  const body = h('tbody');
  let leftNo = 0;
  let rightNo = 0;
  for (const row of rows) {
    const hasLeft = Boolean(row.left);
    const hasRight = Boolean(row.right);
    if (hasLeft) leftNo += 1;
    if (hasRight) rightNo += 1;
    const leftTone = row.type === 'remove'
      ? 'diff-remove'
      : row.type === 'change' ? 'diff-change-left' : '';
    const rightTone = row.type === 'add'
      ? 'diff-add'
      : row.type === 'change' ? 'diff-change-right' : '';
    const leftClass = [leftTone, row.left?.type === 'code' ? 'code-cell' : '']
      .filter(Boolean)
      .join(' ');
    const rightClass = [rightTone, row.right?.type === 'code' ? 'code-cell' : '']
      .filter(Boolean)
      .join(' ');
    body.append(h('tr', {},
      h('td', { class: leftClass },
        h('div', { class: 'diff-cell' },
          h('span', { class: 'diff-ln', text: hasLeft ? String(leftNo) : '' }),
          h('div', { class: 'diff-content' }, hasLeft ? renderDocBlock(row.left) : ''),
        ),
      ),
      h('td', { class: rightClass },
        h('div', { class: 'diff-cell' },
          h('span', { class: 'diff-ln', text: hasRight ? String(rightNo) : '' }),
          h('div', { class: 'diff-content' }, hasRight ? renderDocBlock(row.right) : ''),
        ),
      ),
    ));
  }
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'doc-diff' },
      h('thead', {}, h('tr', {},
        h('th', { text: '上一版本' }),
        h('th', { text: '当前版本' }),
      )),
      body,
    ),
  );
}

function computeLineDiff(beforeText, afterText) {
  const left = String(beforeText ?? '').split('\n');
  const right = String(afterText ?? '').split('\n');
  const rows = [];

  if (left.length * right.length > 250000) {
    for (const line of left) rows.push({ type: 'remove', left: line, right: '' });
    for (const line of right) rows.push({ type: 'add', left: '', right: line });
    return rows;
  }

  const table = Array.from({ length: left.length + 1 }, () =>
    new Uint16Array(right.length + 1),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      ops.push({ type: 'same', left: left[i], right: right[j] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: 'remove', left: left[i], right: '' });
      i += 1;
    } else {
      ops.push({ type: 'add', left: '', right: right[j] });
      j += 1;
    }
  }
  while (i < left.length) {
    ops.push({ type: 'remove', left: left[i], right: '' });
    i += 1;
  }
  while (j < right.length) {
    ops.push({ type: 'add', left: '', right: right[j] });
    j += 1;
  }

  let index = 0;
  while (index < ops.length) {
    if (ops[index].type === 'same') {
      rows.push(ops[index]);
      index += 1;
      continue;
    }
    const removes = [];
    const adds = [];
    while (index < ops.length && ops[index].type === 'remove') {
      removes.push(ops[index].left);
      index += 1;
    }
    while (index < ops.length && ops[index].type === 'add') {
      adds.push(ops[index].right);
      index += 1;
    }
    const size = Math.max(removes.length, adds.length);
    for (let offset = 0; offset < size; offset += 1) {
      const hasLeft = removes[offset] !== undefined;
      const hasRight = adds[offset] !== undefined;
      rows.push({
        type: hasLeft && hasRight ? 'change' : hasLeft ? 'remove' : 'add',
        left: hasLeft ? removes[offset] : '',
        right: hasRight ? adds[offset] : '',
      });
    }
  }
  return rows;
}

function renderSideBySide(rows) {
  const body = h('tbody');
  let leftNo = 0;
  let rightNo = 0;
  for (const row of rows) {
    const hasLeft = row.type === 'same' || row.type === 'remove' || row.type === 'change';
    const hasRight = row.type === 'same' || row.type === 'add' || row.type === 'change';
    if (hasLeft) leftNo += 1;
    if (hasRight) rightNo += 1;
    body.append(h('tr', {},
      h('td', { class: 'ln', text: hasLeft ? String(leftNo) : '' }),
      h('td', {
        class: `code${row.type === 'remove' || row.type === 'change' ? ' side-remove' : ''}`,
        text: hasLeft ? row.left : '',
      }),
      h('td', { class: 'ln', text: hasRight ? String(rightNo) : '' }),
      h('td', {
        class: `code${row.type === 'add' || row.type === 'change' ? ' side-add' : ''}`,
        text: hasRight ? row.right : '',
      }),
    ));
  }
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'side-diff' },
      h('thead', {}, h('tr', {},
        h('th', { colspan: '2', text: '上一版本' }),
        h('th', { colspan: '2', text: '当前版本' }),
      )),
      body,
    ),
  );
}

function renderEntityDiff(title, rows, label) {
  return h('div', { class: 'diff-section' },
    h('h4', { text: `${title} · ${rows.length}` }),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'entity-diff' },
        h('thead', {}, h('tr', {},
          h('th', { text: '上一版本' }),
          h('th', { text: '当前版本' }),
        )),
        h('tbody', {}, ...rows.map((row) => {
          const leftTone = row.status === 'remove' || row.status === 'change' ? 'side-remove' : '';
          const rightTone = row.status === 'add' || row.status === 'change' ? 'side-add' : '';
          return h('tr', {},
            h('td', { class: leftTone, text: row.left ? label(row.left) : '' }),
            h('td', { class: rightTone, text: row.right ? label(row.right) : '' }),
          );
        })),
      ),
    ),
  );
}

function setDiffSummary(collectionCount, requestCount) {
  diffSummary.replaceChildren(
    h('span', { class: 'badge team', text: `接口 +${requestCount.add} / -${requestCount.remove} / 改 ${requestCount.change}` }),
    h('span', { class: 'badge', text: `集合 +${collectionCount.add} / -${collectionCount.remove} / 改 ${collectionCount.change}` }),
  );
}

function resetDiffNav() {
  diffState.blocks = [];
  diffState.outline = [];
  diffState.index = -1;
  diffState.jumpUntil = 0;
  clearTimeout(diffState.focusTimer);
  diffNavPos.textContent = '0 / 0';
  $('#diff-prev').disabled = true;
  $('#diff-next').disabled = true;
  diffOutline.replaceChildren();
}

function buildDiffOutline(diff, currentCollections, currentRequests, removedRequests, sectionOf, collectionTargets) {
  diffState.outline = [];
  diffOutline.replaceChildren(h('div', { class: 'diff-outline-title', text: '大纲' }));

  const appendItem = (list, entry) => {
    const button = h('button', {
      class: 'diff-outline-item' + (entry.sub ? ' sub' : '') + (entry.collection ? ' collection' : ''),
      type: 'button',
      'data-target': entry.target,
    },
      ...(entry.tag ? [entry.tag] : []),
      h('span', { class: 'name', text: entry.label }),
      ...(entry.count === undefined ? [] : [h('span', { class: 'count', text: String(entry.count) })]),
    );
    list.append(button);
    diffState.outline.push({ id: entry.target, button });
  };
  const requestEntry = (row) => ({
    label: row.name,
    tag: h('span', { class: `method ${row.method}`, text: row.method }),
    target: sectionOf.get(row.id),
    sub: true,
  });

  const overview = h('div', { class: 'diff-outline-group' });
  appendItem(overview, { label: `集合 · ${currentCollections.length}`, target: 'diff-sec-collections' });
  appendItem(overview, { label: `接口 · ${currentRequests.length}`, target: 'diff-sec-requests' });
  diffOutline.append(h('div', { class: 'diff-outline-title', text: '概览' }), overview);

  const byCollection = new Map();
  const loose = [];
  for (const row of currentRequests) {
    const collectionId = row.right?.collectionId;
    if (collectionId && collectionTargets.has(collectionId)) {
      if (!byCollection.has(collectionId)) byCollection.set(collectionId, []);
      byCollection.get(collectionId).push(row);
    } else {
      loose.push(row);
    }
  }
  for (const row of currentCollections) {
    const list = h('div', { class: 'diff-outline-group' });
    const items = byCollection.get(row.right.id) || [];
    appendItem(list, {
      label: row.right.name || row.id,
      target: collectionTargets.get(row.right.id),
      collection: true,
      count: items.length,
    });
    for (const item of items) appendItem(list, requestEntry(item));
    diffOutline.append(list);
  }
  if (loose.length) {
    const list = h('div', { class: 'diff-outline-group' });
    diffOutline.append(h('div', { class: 'diff-outline-title', text: '未分组接口' }), list);
    for (const row of loose) appendItem(list, requestEntry(row));
  }
  if (removedRequests.length) {
    const list = h('div', { class: 'diff-outline-group' });
    diffOutline.append(h('div', { class: 'diff-outline-title', text: `已删除接口 · ${removedRequests.length}` }), list);
    for (const row of removedRequests) appendItem(list, requestEntry(row));
  }
}

function setOutlineActive(id) {
  for (const entry of diffState.outline) {
    entry.button.classList.toggle('active', entry.id === id);
  }
}

function scrollDiffTo(element, offset = 10) {
  if (!element) return;
  const bodyTop = diffBody.getBoundingClientRect().top;
  const top = diffBody.scrollTop + element.getBoundingClientRect().top - bodyTop - offset;
  diffBody.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function jumpDiffSection(id) {
  const section = document.getElementById(id);
  if (!section) return;
  scrollDiffTo(section, 6);
  setOutlineActive(id);
}

function collectDiffBlocks() {
  const blocks = [];
  for (const table of diffBody.querySelectorAll('.doc-diff, .entity-diff')) {
    let current = null;
    for (const row of table.querySelectorAll('tbody tr')) {
      const changed = Boolean(row.querySelector(
        'td.side-add, td.side-remove, td.diff-add, td.diff-remove, td.diff-change-left, td.diff-change-right',
      ));
      if (!changed) {
        current = null;
        continue;
      }
      if (current) current.rows.push(row);
      else {
        current = { rows: [row], anchor: row };
        blocks.push(current);
      }
    }
  }
  return blocks;
}

function diffCurrentIndex() {
  const bodyTop = diffBody.getBoundingClientRect().top;
  let index = -1;
  diffState.blocks.forEach((block, i) => {
    if (block.anchor.getBoundingClientRect().top - bodyTop <= 96) index = i;
  });
  return index;
}

function setDiffPosition(index) {
  const total = diffState.blocks.length;
  diffState.index = index;
  diffNavPos.textContent = total ? `${index >= 0 ? index + 1 : 0} / ${total}` : '0 / 0';
}

function focusDiffChange(index) {
  const block = diffState.blocks[index];
  if (!block) return;
  diffState.blocks.forEach((item) => item.rows.forEach((row) => row.classList.remove('diff-focus')));
  block.rows.forEach((row) => row.classList.add('diff-focus'));
  clearTimeout(diffState.focusTimer);
  diffState.focusTimer = setTimeout(() => {
    block.rows.forEach((row) => row.classList.remove('diff-focus'));
  }, 1600);
  diffState.jumpUntil = Date.now() + 600;
  scrollDiffTo(block.anchor, 110);
  setDiffPosition(index);
  const section = block.anchor.closest('.diff-section');
  if (section?.id) setOutlineActive(section.id);
}

function jumpDiffChange(delta) {
  const total = diffState.blocks.length;
  if (!total) return;
  const current = diffState.index;
  let next;
  if (delta > 0) next = current < 0 ? 0 : (current + 1) % total;
  else next = current <= 0 ? total - 1 : current - 1;
  focusDiffChange(next);
}

function onDiffScroll() {
  if (diffState.scrollRaf) return;
  diffState.scrollRaf = requestAnimationFrame(() => {
    diffState.scrollRaf = 0;
    if (Date.now() < diffState.jumpUntil) return;
    setDiffPosition(diffCurrentIndex());
    const bodyTop = diffBody.getBoundingClientRect().top;
    let active = '';
    let best = -Infinity;
    for (const entry of diffState.outline) {
      const section = document.getElementById(entry.id);
      if (!section) continue;
      const top = section.getBoundingClientRect().top - bodyTop;
      if (top <= 80 && top > best) {
        best = top;
        active = entry.id;
      }
    }
    if (active) setOutlineActive(active);
  });
}

function renderSideDiff(diff, fromRevision, toRevision) {
  diffTitle.textContent = `版本对比 · #${fromRevision} → #${toRevision}`;
  resetDiffNav();
  const { collectionCount, requestCount } = diff;
  setDiffSummary(collectionCount, requestCount);
  const total =
    collectionCount.add + collectionCount.remove + collectionCount.change +
    requestCount.add + requestCount.remove + requestCount.change;

  if (total === 0) {
    diffBody.replaceChildren(h('p', { class: 'section-note', text: '两个版本内容一致。' }));
    diffOutline.append(
      h('div', { class: 'diff-outline-title', text: '大纲' }),
      h('div', { class: 'diff-outline-empty', text: '无变更' }),
    );
    diffDialog.showModal();
    return;
  }

  const currentCollections = diff.collections
    .filter((row) => row.right)
    .sort((a, b) => (a.right.sort ?? 0) - (b.right.sort ?? 0));
  const collectionIndex = new Map(currentCollections.map((row, index) => [row.right.id, index]));
  const currentRequests = diff.requests
    .filter((row) => row.right)
    .sort((a, b) => {
      const left = collectionIndex.get(a.right.collectionId) ?? 999;
      const right = collectionIndex.get(b.right.collectionId) ?? 999;
      return left - right || (a.right.sort ?? 0) - (b.right.sort ?? 0);
    });
  const removedRequests = diff.requests.filter((row) => !row.right && row.left);
  const displayRequests = [...currentRequests, ...removedRequests];

  const collectionsSection = renderEntityDiff('集合', diff.collections, (item) => item.name || item.id);
  collectionsSection.id = 'diff-sec-collections';
  const collectionTargets = new Map();
  [...collectionsSection.querySelectorAll('tbody tr')].forEach((row, index) => {
    row.id = `diff-col-${index}`;
    const collection = diff.collections[index];
    if (collection?.right) collectionTargets.set(collection.right.id, row.id);
  });
  const requestsSection = renderEntityDiff('接口', diff.requests, (item) => `${item.method} ${item.name}`);
  requestsSection.id = 'diff-sec-requests';

  const sectionOf = new Map();
  const contentSections = displayRequests.map((row, index) => {
    const section = h('div', { class: 'diff-section' },
      h('h4', { text: `接口内容 · ${row.method} ${row.name}` }),
      renderDocDiff(row.leftBlocks, row.rightBlocks),
    );
    section.id = `diff-sec-req-${index}`;
    sectionOf.set(row.id, section.id);
    return section;
  });

  diffBody.replaceChildren(collectionsSection, requestsSection, ...contentSections);
  buildDiffOutline(diff, currentCollections, currentRequests, removedRequests, sectionOf, collectionTargets);
  diffBody.scrollTop = 0;
  diffState.blocks = collectDiffBlocks();
  $('#diff-prev').disabled = false;
  $('#diff-next').disabled = false;
  setDiffPosition(-1);
  setOutlineActive('diff-sec-collections');
  diffDialog.showModal();
}

async function openDiff(fromRevision, toRevision) {
  if (!fromRevision || !toRevision || fromRevision === toRevision) {
    showToast('请选择两个不同的版本', 'error');
    return;
  }
  try {
    const [before, after] = await Promise.all([
      api(`/v1/teams/${state.team.id}/snapshots/${fromRevision}`),
      api(`/v1/teams/${state.team.id}/snapshots/${toRevision}`),
    ]);
    renderSideDiff(buildSideDiff(before, after), fromRevision, toRevision);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

export { collectionName, buildSnapshotDiff, diffSection, renderDiff, requestContentLines, buildSideDiff, requestDocBlocks, docBlockSignature, computeBlockDiff, renderDocBlock, renderDocDiff, computeLineDiff, renderSideBySide, renderEntityDiff, setDiffSummary, resetDiffNav, buildDiffOutline, setOutlineActive, scrollDiffTo, jumpDiffSection, collectDiffBlocks, diffCurrentIndex, setDiffPosition, focusDiffChange, jumpDiffChange, onDiffScroll, renderSideDiff, openDiff };
