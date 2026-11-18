import type { HeaderPair } from './api';

export type ResponseFormat = 'json' | 'xml' | 'html' | 'text';
export type ResponseFormatChoice = 'auto' | ResponseFormat;
export type ResponseViewMode = 'pretty' | 'raw' | 'preview';
export type ResponseEncoding = 'auto' | 'utf-8' | 'gbk' | 'gb18030' | 'big5' | 'iso-8859-1';

export const RESPONSE_FORMAT_OPTIONS: Array<{ value: ResponseFormatChoice; label: string }> = [
  { value: 'auto', label: '自动识别' },
  { value: 'json', label: 'JSON' },
  { value: 'xml', label: 'XML' },
  { value: 'html', label: 'HTML' },
  { value: 'text', label: '文本' },
];

export const RESPONSE_ENCODING_OPTIONS: Array<{ value: ResponseEncoding; label: string }> = [
  { value: 'auto', label: '自动识别' },
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'gbk', label: 'GBK / GB2312' },
  { value: 'gb18030', label: 'GB18030' },
  { value: 'big5', label: 'Big5' },
  { value: 'iso-8859-1', label: 'ISO-8859-1' },
];

export function readContentType(headers: HeaderPair[]): string {
  return (
    headers.find((header) => header.name.toLowerCase() === 'content-type')?.value ?? ''
  );
}

export function detectResponseFormat(contentType: string, body: string): ResponseFormat {
  const type = contentType.toLowerCase();
  if (type.includes('json')) return 'json';
  if (type.includes('html')) return 'html';
  if (type.includes('xml')) return 'xml';
  if (type.startsWith('text/')) return 'text';

  const trimmed = body.trimStart();
  if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return 'html';
  if (trimmed.startsWith('<?xml')) return 'xml';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (trimmed.startsWith('<')) return 'xml';
  return 'text';
}

export function decodeResponseBody(
  body: string,
  bodyBase64: string | undefined,
  contentType: string,
  encoding: ResponseEncoding,
): string {
  const bytes = base64ToBytes(bodyBase64);
  if (!bytes) return body;
  const label = encoding === 'auto' ? detectEncodingLabel(contentType, bytes) : encoding;
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return body;
  }
}

export function detectedEncodingLabel(
  contentType: string,
  bodyBase64?: string,
): ResponseEncoding {
  const bytes = base64ToBytes(bodyBase64);
  return bytes ? detectEncodingLabel(contentType, bytes) : 'utf-8';
}

export function formatResponseBody(
  body: string,
  format: ResponseFormat,
  mode: Exclude<ResponseViewMode, 'preview'>,
): string {
  if (mode === 'raw') return body;
  if (format === 'json') {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
  if (format === 'xml') return formatXml(body);
  if (format === 'html') return formatHtml(body);
  return body;
}

export function buildHtmlPreview(html: string, requestUrl: string): string {
  const withoutCharset = html
    .replace(/<meta[^>]*charset\s*=[^>]*>/gi, '')
    .replace(/<base[^>]*>/gi, '');

  let base = '';
  try {
    base = new URL('.', requestUrl).href;
  } catch {
    base = '';
  }
  const injected = [
    '<meta charset="utf-8">',
    base ? `<base href="${escapeAttribute(base)}">` : '',
  ]
    .filter(Boolean)
    .join('');

  if (/<head[^>]*>/i.test(withoutCharset)) {
    return withoutCharset.replace(/<head[^>]*>/i, (match) => `${match}${injected}`);
  }
  if (/<html[^>]*>/i.test(withoutCharset)) {
    return withoutCharset.replace(/<html[^>]*>/i, (match) => `${match}<head>${injected}</head>`);
  }
  return `${injected}${withoutCharset}`;
}

function formatXml(source: string): string {
  return indentMarkup(source, null);
}

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function formatHtml(source: string): string {
  return indentMarkup(source, VOID_ELEMENTS);
}

function indentMarkup(source: string, voidElements: Set<string> | null): string {
  const lines = splitMarkup(source);
  if (lines.length <= 1) return source;

  const result: string[] = [];
  let depth = 0;
  for (const line of lines) {
    const leadingClose = /^<\//.test(line);
    if (leadingClose) depth = Math.max(0, depth - 1);
    result.push(`${'  '.repeat(depth)}${line}`);

    const opens = countOpeningTags(line, voidElements);
    const closes =
      (line.match(/<\/[a-zA-Z][\w:-]*\s*>/g) ?? []).length - (leadingClose ? 1 : 0);
    depth = Math.max(0, depth + opens - closes);
  }
  return result.join('\n');
}

function countOpeningTags(line: string, voidElements: Set<string> | null): number {
  let count = 0;
  const pattern = /<([a-zA-Z][\w:-]*)(?:\s[^>]*?)?>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    if (match[0].endsWith('/>')) continue;
    if (voidElements?.has(match[1].toLowerCase())) continue;
    count += 1;
  }
  return count;
}

function splitMarkup(source: string): string[] {
  return source
    .replace(/>\s*</g, '>\n<')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function detectEncodingLabel(contentType: string, bytes: Uint8Array): ResponseEncoding {
  const fromHeader = /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType)?.[1];
  const fromHtml = charsetFromHtml(bytes);
  return normalizeEncoding(fromHeader ?? fromHtml ?? 'utf-8');
}

function charsetFromHtml(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, 4096);
  let text = '';
  for (const byte of head) text += String.fromCharCode(byte);
  const direct = /<meta[^>]+charset\s*=\s*["']?([^"'\s/>;]+)/i.exec(text)?.[1];
  if (direct) return direct;
  return /content\s*=\s*["'][^"']*charset\s*=\s*([^"'\s;]+)/i.exec(text)?.[1] ?? null;
}

function normalizeEncoding(raw: string): ResponseEncoding {
  const value = raw.trim().toLowerCase();
  if (value === 'utf8' || value === 'utf-8') return 'utf-8';
  if (value === 'gb2312' || value === 'gbk') return 'gbk';
  if (value === 'gb18030') return 'gb18030';
  if (value === 'big5') return 'big5';
  if (value === 'latin1' || value === 'iso-8859-1') return 'iso-8859-1';
  return 'utf-8';
}

function base64ToBytes(value: string | undefined): Uint8Array | null {
  if (!value) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
