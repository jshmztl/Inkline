import { state, dataLevelText, showToast } from './core.js';
import { contentRequests, contentCollection, contentRequest, contentDocument } from './workspace.js';

function safeFileName(value) {
  return String(value || 'inkline-export')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'inkline-export';
}

function downloadText(name, text, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 30000);
}

function exportContent(type, id, format) {
  try {
    if (type === 'collection') {
      const collection = contentCollection(id);
      if (!collection) throw new Error('集合不存在');
      const requests = contentRequests().filter(
        (request) => (request.collectionId || '') === id,
      );
      if (format === 'json') {
        downloadText(`${safeFileName(collection.name)}.json`, JSON.stringify({
          info: {
            name: collection.name,
            revision: state.workspace?.revision ?? null,
            exportedAt: new Date().toISOString(),
          },
          collection,
          requests,
          documents: Object.fromEntries(
            requests.map((request) => [request.id, contentDocument(request.id)]),
          ),
        }, null, 2), 'application/json');
      } else if (format === 'html') {
        downloadText(`${safeFileName(collection.name)}.html`, buildCollectionHtml(collection, requests), 'text/html');
      } else {
        downloadText(`${safeFileName(collection.name)}.md`, buildCollectionMarkdown(collection, requests), 'text/markdown');
      }
      showToast('集合已导出');
      return;
    }

    const request = contentRequest(id);
    if (!request) throw new Error('接口不存在');
    const collection = contentCollection(request.collectionId || '');
    if (format === 'json') {
      downloadText(`${safeFileName(request.name)}.json`, JSON.stringify({
        collection,
        request,
        document: contentDocument(request.id),
      }, null, 2), 'application/json');
    } else if (format === 'html') {
      downloadText(`${safeFileName(request.name)}.html`, buildRequestHtml(request), 'text/html');
    } else {
      downloadText(`${safeFileName(request.name)}.md`, buildRequestMarkdown(request), 'text/markdown');
    }
    showToast('接口文档已导出');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function mdCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function mdTable(headers, rows) {
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];
  for (const row of rows) {
    lines.push(`| ${row.map(mdCell).join(' | ')} |`);
  }
  return lines.join('\n');
}

function requestMarkdown(request, level = 2) {
  const heading = '#'.repeat(Math.min(6, level));
  const sub = '#'.repeat(Math.min(6, level + 1));
  const collection = contentCollection(request.collectionId || '');
  const headers = Array.isArray(request.headers) ? request.headers : [];
  const docs = contentDocument(request.id);
  const lines = [];

  lines.push(`${heading} ${request.name || '未命名接口'}`);
  lines.push('');
  lines.push(`- 方法：\`${request.method || 'GET'}\``);
  lines.push(`- 路径：\`${request.url || request.path || ''}\``);
  if (collection) lines.push(`- 所属集合：${collection.name}`);
  lines.push(`- 数据分级：${dataLevelText(request.dataLevel || 'L1')}`);
  lines.push('');
  lines.push(`${sub} 请求头`);
  lines.push('');
  lines.push(headers.length
    ? mdTable(['名称', '值'], headers.map((header) => [header.name, header.value]))
    : '无');
  lines.push('');
  lines.push(`${sub} 请求体`);
  lines.push('');
  if (request.body) {
    lines.push('```json');
    lines.push(String(request.body));
    lines.push('```');
  } else {
    lines.push('无');
  }
  lines.push('');
  lines.push(`${sub} 字段说明`);
  lines.push('');
  lines.push(docs.length
    ? mdTable(['字段', '路径', '类型', '来源', '说明'], docs.map((field) => [
        field.key,
        field.path,
        field.type,
        field.source,
        field.description,
      ]))
    : '暂无字段说明。');
  return lines.join('\n');
}

function buildRequestMarkdown(request) {
  return [
    `# ${request.name || '接口文档'}`,
    '',
    `> 导出自 Inkline 团队服务 · 快照 #${state.workspace?.revision ?? '-'} · ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
    requestMarkdown(request, 2),
    '',
  ].join('\n');
}

function buildCollectionMarkdown(collection, requests) {
  const lines = [
    `# ${collection.name}`,
    '',
    `> 导出自 Inkline 团队服务 · 快照 #${state.workspace?.revision ?? '-'} · ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `> 接口数量：${requests.length}`,
    '',
    '## 接口列表',
    '',
  ];
  if (!requests.length) {
    lines.push('暂无接口。');
  } else {
    for (const request of requests) {
      lines.push(`- \`${request.method || 'GET'}\` ${request.name || '未命名接口'}`);
    }
    lines.push('');
    for (const request of requests) {
      lines.push(requestMarkdown(request, 2));
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }
  return lines.join('\n');
}

function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function htmlTable(headers, rows) {
  return `<table><thead><tr>${headers.map((text) => `<th>${escHtml(text)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escHtml(cell ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function requestHtml(request, level = 2) {
  const tag = `h${Math.min(6, level)}`;
  const sub = `h${Math.min(6, level + 1)}`;
  const collection = contentCollection(request.collectionId || '');
  const headers = Array.isArray(request.headers) ? request.headers : [];
  const docs = contentDocument(request.id);
  const body = request.body
    ? `<pre>${escHtml(request.body)}</pre>`
    : '<p class="muted">无请求体。</p>';

  return `<section class="api">
<${tag}>${escHtml(request.name || '未命名接口')}</${tag}>
<dl>
<dt>方法</dt><dd><code>${escHtml(request.method || 'GET')}</code></dd>
<dt>路径</dt><dd><code>${escHtml(request.url || request.path || '')}</code></dd>
<dt>集合</dt><dd>${escHtml(collection ? collection.name : '未分组')}</dd>
<dt>数据分级</dt><dd>${escHtml(dataLevelText(request.dataLevel || 'L1'))}</dd>
</dl>
<${sub}>请求头</${sub}>
${headers.length ? htmlTable(['名称', '值'], headers.map((header) => [header.name, header.value])) : '<p class="muted">未配置请求头。</p>'}
<${sub}>请求体</${sub}>
${body}
<${sub}>字段说明</${sub}>
${docs.length ? htmlTable(['字段', '路径', '类型', '来源', '说明'], docs.map((field) => [field.key, field.path, field.type, field.source, field.description])) : '<p class="muted">暂无字段说明。</p>'}
</section>`;
}

function htmlShell(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)} · Inkline 接口文档</title>
<style>
body { margin: 0; padding: 40px 24px; background: #f6f8fc; color: #0f172a; font: 14px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
main { max-width: 960px; margin: 0 auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 32px 36px; box-shadow: 0 12px 40px rgba(15,23,42,.06); }
h1 { font-size: 28px; margin: 0 0 6px; }
h2 { font-size: 22px; margin: 32px 0 10px; padding-top: 18px; border-top: 1px solid #e2e8f0; }
h3 { font-size: 16px; margin: 20px 0 8px; }
.lead { color: #64748b; margin: 0 0 24px; }
.api { margin-top: 28px; }
dl { display: grid; grid-template-columns: 90px 1fr; gap: 6px 14px; margin: 12px 0 18px; }
dt { color: #64748b; font-size: 12px; }
dd { margin: 0; word-break: break-all; }
code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; background: #f1f5f9; padding: 1px 5px; border-radius: 5px; }
pre { background: #0b1220; color: #dbeafe; padding: 14px 16px; border-radius: 10px; overflow: auto; font-size: 12px; line-height: 1.6; }
table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eef2f7; font-size: 13px; vertical-align: top; }
th { background: #f8fafc; color: #64748b; font-weight: 500; font-size: 12px; }
.muted { color: #94a3b8; }
footer { margin-top: 32px; color: #94a3b8; font-size: 12px; }
@media print { body { background: #fff; padding: 0; } main { border: 0; box-shadow: none; padding: 0; } pre { white-space: pre-wrap; } }
</style>
</head>
<body>
<main>
${body}
<footer>由 Inkline 团队服务导出 · 快照 #${state.workspace?.revision ?? '-'} · ${new Date().toLocaleString('zh-CN', { hour12: false })}</footer>
</main>
</body>
</html>`;
}

function buildRequestHtml(request) {
  return htmlShell(
    request.name || '接口文档',
    `<h1>${escHtml(request.name || '接口文档')}</h1><p class="lead">${escHtml(request.method || 'GET')} ${escHtml(request.url || request.path || '')}</p>${requestHtml(request, 2)}`,
  );
}

function buildCollectionHtml(collection, requests) {
  return htmlShell(
    collection.name,
    `<h1>${escHtml(collection.name)}</h1><p class="lead">${requests.length} 个接口</p>${requests.map((request) => requestHtml(request, 2)).join('\n')}`,
  );
}


export { mdCell, mdTable, requestMarkdown, buildRequestMarkdown, buildCollectionMarkdown, escHtml, htmlTable, requestHtml, htmlShell, buildRequestHtml, buildCollectionHtml, safeFileName, downloadText, exportContent };
