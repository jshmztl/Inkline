import {
  docToMarkdown,
  docToOpenApi,
  type DocTask,
  type DraftField,
} from './docTask';

// 导出接口文档为 Markdown 或 OpenAPI 文件。
export function downloadDocFile(
  task: DocTask,
  draft: DraftField[],
  format: 'markdown' | 'openapi',
) {
  const content =
    format === 'markdown' ? docToMarkdown(task, draft) : docToOpenApi(task, draft);
  const extension = format === 'markdown' ? 'md' : 'openapi.json';
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${task.request.name}.${extension}`;
  link.click();
  URL.revokeObjectURL(url);
}

// 复制 Markdown 到剪贴板，返回是否成功。
export async function copyMarkdown(markdown: string): Promise<boolean> {
  if (!markdown) return false;
  try {
    await navigator.clipboard.writeText(markdown);
    return true;
  } catch {
    return false;
  }
}
