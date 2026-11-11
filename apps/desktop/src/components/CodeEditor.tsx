import { useMemo, useRef, type ReactNode } from 'react';

export type CodeLanguage = 'json' | 'xml' | 'text';

const JSON_TOKEN =
  /("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b)/g;

const XML_TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[\w:.-]+|\/?>|"[^"]*"|'[^']*'|[\w:.-]+(?=\s*=)/g;

function highlightJson(text: string): ReactNode[] {
  return text.split(JSON_TOKEN).map((part, index) => {
    if (!part) return null;
    let className = 'tok-punc';
    if (/^".*":\s*$/.test(part)) {
      className = 'tok-key';
    } else if (/^"/.test(part)) {
      className = 'tok-str';
    } else if (/^-?\d/.test(part)) {
      className = 'tok-num';
    } else if (/^(true|false|null)$/.test(part)) {
      className = 'tok-bool';
    }
    return (
      <span className={className} key={index}>
        {part}
      </span>
    );
  });
}

function highlightXml(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let index = 0;

  for (const match of text.matchAll(XML_TOKEN)) {
    const found = match[0];
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    let className = 'tok-attr';
    if (found.startsWith('<!--')) className = 'tok-comment';
    else if (found.startsWith('<?') || found.startsWith('<!')) className = 'tok-meta';
    else if (found.startsWith('<')) className = 'tok-tag';
    else if (found === '>' || found === '/>') className = 'tok-punc';
    else if (/^["']/.test(found)) className = 'tok-str';
    nodes.push(
      <span className={className} key={`x${index}`}>
        {found}
      </span>,
    );
    index += 1;
    cursor = start + found.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function formatJson(input: string): { ok: boolean; value: string } {
  try {
    return { ok: true, value: JSON.stringify(JSON.parse(input), null, 2) };
  } catch {
    return { ok: false, value: input };
  }
}

export function formatXml(input: string): { ok: boolean; value: string } {
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(input, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) {
      return { ok: false, value: input };
    }
  }

  const compact = input
    .replace(/>\s+</g, '><')
    .replace(/\s+</g, '<')
    .replace(/>\s+/g, '>')
    .trim();
  if (!compact) return { ok: true, value: '' };

  const lines = compact.replace(/(>)(<)(\/*)/g, '$1\n$2$3').split('\n');
  let depth = 0;
  const output = lines.map((line) => {
    const closing = /^<\//.test(line);
    if (closing) depth = Math.max(depth - 1, 0);
    const row = `${'  '.repeat(depth)}${line}`;
    const opening =
      /^<[\w:.-]+[^>]*>$/.test(line) &&
      !/\/>$/.test(line) &&
      !/^<\?/.test(line) &&
      !/^<!/.test(line) &&
      !/<\//.test(line);
    if (opening) depth += 1;
    return row;
  });

  return { ok: true, value: output.join('\n') };
}

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: CodeLanguage;
  ariaLabel?: string;
  placeholder?: string;
  onScrollTopChange?: (scrollTop: number) => void;
}

export function CodeEditor({
  value,
  onChange,
  language = 'text',
  ariaLabel,
  placeholder,
  onScrollTopChange,
}: CodeEditorProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const tokens = useMemo(() => {
    if (language === 'json') return highlightJson(value);
    if (language === 'xml') return highlightXml(value);
    return [value];
  }, [language, value]);

  return (
    <div className={`code-editor language-${language}`}>
      <pre className="code-editor-highlight" ref={preRef} aria-hidden="true">
        {tokens}
        {'\n'}
      </pre>
      <textarea
        className="code-editor-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          const pre = preRef.current;
          const scrollTop = event.currentTarget.scrollTop;
          if (pre) {
            pre.scrollTop = scrollTop;
            pre.scrollLeft = event.currentTarget.scrollLeft;
          }
          onScrollTopChange?.(scrollTop);
        }}
        spellCheck={false}
        wrap="off"
        aria-label={ariaLabel}
        placeholder={placeholder}
      />
    </div>
  );
}
