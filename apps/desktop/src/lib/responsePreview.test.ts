import { describe, expect, it } from 'vitest';
import {
  buildHtmlPreview,
  decodeResponseBody,
  detectResponseFormat,
  formatResponseBody,
  readContentType,
} from './responsePreview';

function toBase64(bytes: Iterable<number>): string {
  return btoa(String.fromCharCode(...Array.from(bytes)));
}

describe('responsePreview', () => {
  it('按 Content-Type 识别响应格式', () => {
    expect(detectResponseFormat('application/json; charset=utf-8', '')).toBe('json');
    expect(detectResponseFormat('text/html; charset=gbk', '')).toBe('html');
    expect(detectResponseFormat('application/rss+xml', '')).toBe('xml');
    expect(detectResponseFormat('text/plain', 'hello')).toBe('text');
    expect(readContentType([{ name: 'Content-Type', value: 'text/html' }])).toBe('text/html');
  });

  it('没有 Content-Type 时按正文特征识别', () => {
    expect(detectResponseFormat('', '<!DOCTYPE html><html></html>')).toBe('html');
    expect(detectResponseFormat('', '<html lang="zh"></html>')).toBe('html');
    expect(detectResponseFormat('', '<?xml version="1.0"?><root/>')).toBe('xml');
    expect(detectResponseFormat('', '{"ok":true}')).toBe('json');
    expect(detectResponseFormat('', '[1,2,3]')).toBe('json');
    expect(detectResponseFormat('', 'plain text')).toBe('text');
  });

  it('按头部或 HTML meta 自动识别编码', () => {
    const gbk = [0xd6, 0xd0];
    expect(
      decodeResponseBody('', toBase64(gbk), 'text/html; charset=gbk', 'auto'),
    ).toBe('中');

    const meta = new TextEncoder().encode('<meta charset="gbk">');
    expect(
      decodeResponseBody(
        '',
        toBase64([...meta, ...gbk]),
        'text/html',
        'auto',
      ),
    ).toBe('<meta charset="gbk">中');
  });

  it('支持手动指定编码，缺失原始字节时回退原文', () => {
    const utf8 = new TextEncoder().encode('中文');
    expect(decodeResponseBody('', toBase64(utf8), 'text/plain', 'utf-8')).toBe('中文');
    expect(decodeResponseBody('原文', undefined, 'text/plain', 'gbk')).toBe('原文');
    expect(decodeResponseBody('原文', '%%%', 'text/plain', 'utf-8')).toBe('原文');
  });

  it('美化 JSON 与 XML，原生模式保持原文', () => {
    expect(formatResponseBody('{"a":1}', 'json', 'pretty')).toBe('{\n  "a": 1\n}');
    expect(formatResponseBody('{"a":1}', 'json', 'raw')).toBe('{"a":1}');
    expect(formatResponseBody('<a><b>1</b><c>2</c></a>', 'xml', 'pretty')).toBe(
      '<a>\n  <b>1</b>\n  <c>2</c>\n</a>',
    );
  });

  it('美化 HTML 时正确处理空元素', () => {
    const html =
      '<html><head><meta charset="utf-8"></head><body><img src="a.png"><p>hi</p></body></html>';
    expect(formatResponseBody(html, 'html', 'pretty')).toBe(
      [
        '<html>',
        '  <head>',
        '    <meta charset="utf-8">',
        '  </head>',
        '  <body>',
        '    <img src="a.png">',
        '    <p>hi</p>',
        '  </body>',
        '</html>',
      ].join('\n'),
    );
    expect(formatResponseBody(html, 'html', 'raw')).toBe(html);
  });

  it('为 HTML 预览注入 UTF-8 与 base，并移除原有声明', () => {
    const html =
      '<!doctype html><html><head><meta charset="gbk"><base href="https://a.com/"></head><body>x</body></html>';
    const preview = buildHtmlPreview(html, 'https://example.com/api/page');
    expect(preview).toContain('<meta charset="utf-8">');
    expect(preview).not.toContain('charset="gbk"');
    expect(preview).toContain('<base href="https://example.com/api/">');
    expect(preview.match(/<base/gi)).toHaveLength(1);
  });

  it('片段与非法 URL 也能构造预览', () => {
    const fragment = buildHtmlPreview('<p>hi</p>', 'http://localhost:8080/x');
    expect(fragment).toBe(
      '<meta charset="utf-8"><base href="http://localhost:8080/"><p>hi</p>',
    );

    const noBase = buildHtmlPreview('<p>hi</p>', 'not a url');
    expect(noBase).toBe('<meta charset="utf-8"><p>hi</p>');
  });
});
