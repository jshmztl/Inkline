import { useEffect, useMemo, useRef, useState } from 'react';

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

export function ResponseCode({ body }: { body: string }) {
  const text = useMemo(() => formatBody(body), [body]);
  const lines = useMemo(() => text.split('\n'), [text]);
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
  }, [text]);

  if (!virtual) {
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
              {line || ' '}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
