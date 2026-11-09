import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

const ROW_HEIGHT = 19;
const OVERSCAN = 10;
const VIRTUAL_THRESHOLD = 600;

const JSON_TOKEN =
  /("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b)/g;

function formatBody(body: string) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function highlightJson(text: string) {
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

function markMatches(line: string, needle: string) {
  if (!needle) return line;
  const lower = line.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;

  while (cursor <= line.length) {
    const found = lower.indexOf(needle, cursor);
    if (found < 0) {
      parts.push(line.slice(cursor));
      break;
    }
    if (found > cursor) parts.push(line.slice(cursor, found));
    parts.push(
      <mark key={`${found}-${cursor}`}>{line.slice(found, found + needle.length)}</mark>,
    );
    cursor = found + needle.length;
  }

  return parts;
}

export function ResponseCode({ body, query = '' }: { body: string; query?: string }) {
  const text = useMemo(() => formatBody(body), [body]);
  const needle = query.trim().toLowerCase();
  const lines = useMemo(() => {
    const all = text.split('\n');
    if (!needle) return all;
    return all.filter((line) => line.toLowerCase().includes(needle));
  }, [text, needle]);
  const virtual = lines.length > VIRTUAL_THRESHOLD;
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(360);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setHeight(node.clientHeight);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [virtual]);

  useEffect(() => {
    setScrollTop(ref.current?.scrollTop ?? 0);
  }, [text, needle]);

  if (!virtual) {
    if (needle) {
      return (
        <pre className="code-block response-code">
          {lines.map((line, index) => (
            <div className="response-line" key={index}>
              {markMatches(line, needle) || ' '}
            </div>
          ))}
        </pre>
      );
    }
    return <pre className="code-block response-code">{highlightJson(text)}</pre>;
  }

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visible = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2;
  const end = Math.min(lines.length, start + visible);

  return (
    <div
      ref={ref}
      className="code-block response-code response-virtual"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div
        className="response-virtual-inner"
        style={{ height: lines.length * ROW_HEIGHT }}
      >
        <div style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}>
          {lines.slice(start, end).map((line, index) => (
            <div className="response-line" key={start + index}>
              {markMatches(line, needle) || ' '}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
