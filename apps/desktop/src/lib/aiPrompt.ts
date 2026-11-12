import type { DocTask, FieldReview } from './docTask';

export const extractSystemPrompt = [
  '你是 API 文档解析器。用户会粘贴从 Word 复制的接口说明，请只提取其中一个接口。',
  '只输出一个 JSON 对象，不要输出解释文字或其他内容。',
  'JSON 结构：',
  '{"name":"接口名称","method":"GET|POST|PUT|PATCH|DELETE","url":"接口地址","headers":[{"name":"Header 名","value":"Header 值"}],"body":"请求体示例，没有则为 null"}',
  '要求：',
  '- url 优先使用文档中的完整地址；没有域名时保留以 / 开头的路径',
  '- method 使用文档给出的请求方式，未给出时用 GET',
  '- headers 只保留文档明确列出的请求头',
  '- body 输出原始示例文本（JSON 或表单），不要改写字段',
  '- 文档包含多个接口时，只输出第一个',
].join('\n');

export function parseDescriptionJson(text: string): Record<string, unknown> | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// 字段路径到示例值的映射，供上下文与说明生成复用。
function sampleByPath(task: DocTask) {
  return new Map(
    [...task.request.fields, ...(task.response?.fields ?? [])].map((field) => [
      field.path,
      field.sample,
    ]),
  );
}

// 汇总当前接口上下文，供对话请求复用。
export function buildContextPrompt(task: DocTask, review: FieldReview[]): string {
  const samples = sampleByPath(task);
  const fieldLines = review
    .slice(0, 80)
    .map(
      (field) =>
        `- ${field.path} (${field.type}, ${field.source})${
          samples.get(field.path)
            ? ` 示例: ${String(samples.get(field.path)).slice(0, 80)}`
            : ''
        }`,
    )
    .join('\n');
  return [
    `接口名称：${task.request.name}`,
    `请求：${task.request.method} ${task.request.url}`,
    `敏感级别：${task.request.dataLevel}`,
    task.request.headers.length > 0
      ? `请求头：${task.request.headers.map((header) => header.name).join(', ')}`
      : '',
    task.request.body ? `请求体示例：\n${task.request.body.slice(0, 1500)}` : '',
    task.response
      ? `响应状态：${task.response.status} ${task.response.statusText}\n响应示例：\n${task.response.body.slice(0, 1500)}`
      : '暂无响应示例',
    fieldLines ? `字段列表：\n${fieldLines}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

// 生成字段说明的提示词。
export function buildDescriptionPrompt(task: DocTask, review: FieldReview[]): string {
  const samples = sampleByPath(task);
  const lines = review
    .map(
      (field) =>
        `- ${field.path} | ${field.type} | ${field.source}${
          samples.get(field.path)
            ? ` | 示例: ${String(samples.get(field.path)).slice(0, 100)}`
            : ''
        }`,
    )
    .join('\n');
  return [
    '你是 API 文档助手。请为下列字段各写一句简洁、准确的中文说明，说明字段的业务含义与取值规则。',
    '只输出一个 JSON 对象，键必须是完整字段路径，值为字段说明字符串，不要输出 Markdown 或其他内容。',
    '',
    '字段列表：',
    lines,
  ].join('\n');
}
