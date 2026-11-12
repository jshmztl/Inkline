import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent,
  type SetStateAction,
} from 'react';
import {
  CodeOutlined,
  DeleteOutlined,
  FormatPainterOutlined,
  GlobalOutlined,
  PlusOutlined,
  ProfileOutlined,
} from '@ant-design/icons';
import { App, Button, Checkbox, Input, Segmented, Tooltip } from 'antd';
import type { KvRow } from '../data/types';
import type { DraftField } from '../lib/docTask';
import { describeBodyLines, type BodyLineNote } from '../lib/bodyFields';
import { readGlossary } from '../lib/glossary';
import { kvGet, kvSet } from '../lib/kv';
import { CodeEditor, formatJson, formatXml } from './CodeEditor';

export type BodyMode = 'json' | 'xml' | 'text' | 'form' | 'multipart';

export interface FileRow {
  id: string;
  key: string;
  fileName: string;
  contentType: string;
  contentBase64: string;
  enabled: boolean;
}

interface RequestBodyPanelProps {
  requestId: string;
  body: string;
  onBodyChange: (value: string) => void;
  bodyMode: BodyMode;
  onBodyModeChange: (mode: BodyMode) => void;
  formRows: KvRow[];
  onFormRowsChange: Dispatch<SetStateAction<KvRow[]>>;
  fileRows: FileRow[];
  onFileRowsChange: Dispatch<SetStateAction<FileRow[]>>;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

/** 请求体编辑：模式切换、编辑器、表单行、文件行与字段注释侧栏。 */
export function RequestBodyPanel({
  requestId,
  body,
  onBodyChange,
  bodyMode,
  onBodyModeChange,
  formRows,
  onFormRowsChange,
  fileRows,
  onFileRowsChange,
}: RequestBodyPanelProps) {
  const { message } = App.useApp();
  const [bodyNotesOpen, setBodyNotesOpen] = useState(
    () => kvGet('aw-body-notes-open') !== '0',
  );
  const [bodyNotesWidth, setBodyNotesWidth] = useState(() => {
    const stored = Number(kvGet('aw-body-notes-width'));
    return Number.isFinite(stored) && stored >= 180 ? Math.min(stored, 720) : 288;
  });
  const [resizingNotes, setResizingNotes] = useState(false);
  const bodySplitRef = useRef<HTMLDivElement>(null);
  const bodyNotesWidthRef = useRef(bodyNotesWidth);
  const notesResizeRef = useRef<{
    startX: number;
    startWidth: number;
    maxWidth: number;
  } | null>(null);
  const [docDraft, setDocDraft] = useState<DraftField[]>([]);
  const bodyNotesScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function loadDraft() {
      try {
        const raw = kvGet(`aw-doc-draft:${requestId}`);
        const parsed = raw ? JSON.parse(raw) : [];
        setDocDraft(Array.isArray(parsed) ? (parsed as DraftField[]) : []);
      } catch {
        setDocDraft([]);
      }
    }

    loadDraft();

    function handleDraftUpdated(event: Event) {
      if ((event as CustomEvent<string>).detail === requestId) loadDraft();
    }
    window.addEventListener('aw-doc-draft-updated', handleDraftUpdated);
    return () => window.removeEventListener('aw-doc-draft-updated', handleDraftUpdated);
  }, [requestId]);

  const bodyLineNotes = useMemo(() => {
    if (!bodyNotesOpen || (bodyMode !== 'json' && bodyMode !== 'xml')) return [];
    return describeBodyLines(body, bodyMode, docDraft, readGlossary());
  }, [body, bodyMode, bodyNotesOpen, docDraft]);

  const bodyLineCount = useMemo(() => body.split('\n').length, [body]);

  const lineNoteMap = useMemo(() => {
    const map = new Map<number, BodyLineNote>();
    for (const note of bodyLineNotes) {
      if (!map.has(note.line)) map.set(note.line, note);
    }
    return map;
  }, [bodyLineNotes]);

  function commitBodyNote(path: string, description: string) {
    if (!requestId) return;
    const key = `请求:${path}`;
    const text = description.trim();
    const now = new Date().toISOString();
    const existing = docDraft.find((entry) => entry.key === key);

    let next = docDraft;
    if (existing) {
      next = text
        ? docDraft.map((entry) =>
            entry.key === key ? { ...entry, description: text, updatedAt: now } : entry,
          )
        : docDraft.filter((entry) => entry.key !== key);
    } else if (text) {
      next = [
        ...docDraft,
        {
          key,
          path,
          type: 'string',
          source: '请求',
          description: text,
          updatedAt: now,
        },
      ];
    }

    if (next === docDraft) return;
    setDocDraft(next);
    kvSet(`aw-doc-draft:${requestId}`, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent('aw-doc-draft-updated', { detail: requestId }));
  }

  function clampBodyNotesWidth(width: number) {
    const container = bodySplitRef.current;
    const max = container
      ? Math.min(720, Math.max(240, container.getBoundingClientRect().width - 360))
      : 720;
    return Math.min(max, Math.max(180, width));
  }

  function startNotesResize(event: PointerEvent<HTMLDivElement>) {
    const container = bodySplitRef.current;
    if (!container) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    notesResizeRef.current = {
      startX: event.clientX,
      startWidth: bodyNotesWidth,
      maxWidth: Math.min(
        720,
        Math.max(240, container.getBoundingClientRect().width - 360),
      ),
    };
    setResizingNotes(true);
  }

  function moveNotesResize(event: PointerEvent<HTMLDivElement>) {
    const drag = notesResizeRef.current;
    if (!drag) return;
    const next = Math.min(
      drag.maxWidth,
      Math.max(180, drag.startWidth - (event.clientX - drag.startX)),
    );
    bodyNotesWidthRef.current = next;
    setBodyNotesWidth(next);
  }

  function endNotesResize(event: PointerEvent<HTMLDivElement>) {
    if (!notesResizeRef.current) return;
    notesResizeRef.current = null;
    setResizingNotes(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
    kvSet('aw-body-notes-width', String(Math.round(bodyNotesWidthRef.current)));
  }

  function nudgeNotesWidth(delta: number) {
    const next = clampBodyNotesWidth(bodyNotesWidthRef.current + delta);
    bodyNotesWidthRef.current = next;
    setBodyNotesWidth(next);
    kvSet('aw-body-notes-width', String(Math.round(next)));
  }

  function toggleBodyNotes() {
    setBodyNotesOpen((current) => {
      const next = !current;
      kvSet('aw-body-notes-open', next ? '1' : '0');
      return next;
    });
  }

  function updateFormRow(id: string, patch: Partial<KvRow>) {
    onFormRowsChange((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  }

  function updateFileRow(id: string, patch: Partial<FileRow>) {
    onFileRowsChange((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  }

  async function pickFile(id: string, file: File) {
    try {
      const contentBase64 = await readFileAsBase64(file);
      updateFileRow(id, {
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        contentBase64,
      });
    } catch {
      message.error('读取文件失败');
    }
  }

  function addFormRow() {
    onFormRowsChange((rows) => [
      ...rows,
      {
        id: `form-${Date.now().toString(36)}`,
        key: '',
        value: '',
        description: '',
        enabled: true,
      },
    ]);
  }

  function formatRequestBody() {
    if (bodyMode !== 'json' && bodyMode !== 'xml') return;
    const result = bodyMode === 'json' ? formatJson(body) : formatXml(body);
    if (!result.ok) {
      message.warning(
        bodyMode === 'json' ? 'JSON 语法有误，暂无法格式化' : 'XML 语法有误，暂无法格式化',
      );
      return;
    }
    onBodyChange(result.value);
  }

  return (
    <div className="body-editor">
      <div className="editor-toolbar">
        <Segmented
          size="small"
          value={bodyMode}
          onChange={(value) => onBodyModeChange(value as BodyMode)}
          options={[
            { label: 'JSON', value: 'json' },
            { label: 'XML', value: 'xml' },
            { label: '文本', value: 'text' },
            { label: '表单', value: 'form' },
            { label: 'form-data', value: 'multipart' },
          ]}
        />
        <span className="editor-note">
          {bodyMode === 'json'
            ? 'application/json · 自动格式化'
            : bodyMode === 'xml'
              ? 'application/xml · 自动格式化'
              : bodyMode === 'text'
                ? 'text/plain'
                : bodyMode === 'multipart'
                  ? 'multipart/form-data · 支持文件'
                  : 'application/x-www-form-urlencoded'}
        </span>
        <div className="editor-toolbar-spacer" />
        {(bodyMode === 'json' || bodyMode === 'xml') && (
          <Button
            variant="text"
            size="small"
            icon={<ProfileOutlined />}
            color="geekblue"
            onClick={toggleBodyNotes}
            aria-pressed={bodyNotesOpen}
          >
            {bodyNotesOpen ? '隐藏注释' : '字段注释'}
          </Button>
        )}
        {(bodyMode === 'json' || bodyMode === 'xml') && (
          <Button
            variant="text"
            size="small"
            icon={<FormatPainterOutlined />}
            color="cyan"
            onClick={formatRequestBody}
          >
            格式化
          </Button>
        )}
        <Button variant="text" size="small" icon={<CodeOutlined />} color="geekblue">
          生成代码
        </Button>
      </div>
      {bodyMode === 'form' || bodyMode === 'multipart' ? (
        <div className="kv-editor">
          <div className="kv-head">
            <span />
            <span>KEY</span>
            <span>VALUE</span>
            <span>说明</span>
            <span />
          </div>
          {formRows.map((row) => (
            <div className={`kv-row${row.enabled ? '' : ' disabled'}`} key={row.id}>
              <Checkbox
                checked={row.enabled}
                onChange={(event) =>
                  updateFormRow(row.id, { enabled: event.target.checked })
                }
              />
              <input
                className="kv-input mono"
                value={row.key}
                onChange={(event) => updateFormRow(row.id, { key: event.target.value })}
                aria-label="表单字段名"
              />
              <input
                className="kv-input mono"
                value={row.value}
                onChange={(event) => updateFormRow(row.id, { value: event.target.value })}
                aria-label="表单字段值"
              />
              <input
                className="kv-input"
                value={row.description}
                onChange={(event) =>
                  updateFormRow(row.id, { description: event.target.value })
                }
                aria-label="表单字段说明"
              />
              <Tooltip title="删除">
                <Button
                  type="text"
                  size="small"
                  icon={<DeleteOutlined />}
                  aria-label="删除表单字段"
                  onClick={() =>
                    onFormRowsChange((rows) => rows.filter((item) => item.id !== row.id))
                  }
                />
              </Tooltip>
            </div>
          ))}
          <button type="button" className="kv-add" onClick={addFormRow}>
            <PlusOutlined /> 添加字段
          </button>

          {bodyMode === 'multipart' && (
            <div className="multipart-files">
              <div className="multipart-head">
                <span>FILE</span>
                <span>字段名</span>
                <span>文件</span>
                <span />
              </div>
              {fileRows.map((row) => (
                <div className="multipart-row" key={row.id}>
                  <Checkbox
                    checked={row.enabled}
                    onChange={(event) =>
                      updateFileRow(row.id, { enabled: event.target.checked })
                    }
                  />
                  <input
                    className="kv-input mono"
                    value={row.key}
                    placeholder="file"
                    onChange={(event) => updateFileRow(row.id, { key: event.target.value })}
                    aria-label="文件字段名"
                  />
                  <label className="file-pick">
                    <input
                      type="file"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void pickFile(row.id, file);
                        event.target.value = '';
                      }}
                    />
                    <span title={row.fileName}>{row.fileName || '选择文件'}</span>
                  </label>
                  <Tooltip title="删除">
                    <Button
                      type="text"
                      size="small"
                      icon={<DeleteOutlined />}
                      aria-label="删除文件字段"
                      onClick={() =>
                        onFileRowsChange((rows) => rows.filter((item) => item.id !== row.id))
                      }
                    />
                  </Tooltip>
                </div>
              ))}
              <button
                type="button"
                className="kv-add"
                onClick={() =>
                  onFileRowsChange((rows) => [
                    ...rows,
                    {
                      id: `file-${Date.now().toString(36)}`,
                      key: 'file',
                      fileName: '',
                      contentType: '',
                      contentBase64: '',
                      enabled: true,
                    },
                  ])
                }
              >
                <PlusOutlined /> 添加文件字段
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className={`body-split${resizingNotes ? ' resizing' : ''}`} ref={bodySplitRef}>
          <CodeEditor
            value={body}
            onChange={onBodyChange}
            language={bodyMode === 'json' ? 'json' : bodyMode === 'xml' ? 'xml' : 'text'}
            ariaLabel="请求体"
            placeholder={
              bodyMode === 'json'
                ? '{\n  "key": "value"\n}'
                : bodyMode === 'xml'
                  ? '<root>\n  <key>value</key>\n</root>'
                  : '请输入请求体…'
            }
            onScrollTopChange={(scrollTop) => {
              const node = bodyNotesScrollRef.current;
              if (node) node.scrollTop = scrollTop;
            }}
          />
          {bodyNotesOpen && (bodyMode === 'json' || bodyMode === 'xml') && (
            <>
              <div
                className="body-split-handle"
                role="separator"
                aria-orientation="vertical"
                aria-label="调整字段注释宽度"
                aria-valuemin={180}
                aria-valuenow={Math.round(bodyNotesWidth)}
                tabIndex={0}
                onPointerDown={startNotesResize}
                onPointerMove={moveNotesResize}
                onPointerUp={endNotesResize}
                onPointerCancel={endNotesResize}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft') {
                    event.preventDefault();
                    nudgeNotesWidth(16);
                  } else if (event.key === 'ArrowRight') {
                    event.preventDefault();
                    nudgeNotesWidth(-16);
                  }
                }}
              />
              <aside
                className="body-notes"
                aria-label="字段注释"
                style={{ flex: `0 0 ${bodyNotesWidth}px` }}
              >
                <div className="body-notes-scroll" ref={bodyNotesScrollRef}>
                  <div className="body-notes-lines">
                    {Array.from({ length: bodyLineCount }, (_, line) => {
                      const note = lineNoteMap.get(line);
                      return (
                        <div className="body-notes-line" key={line}>
                          {note && (
                            <>
                              <span className="body-note-mark">//</span>
                              <input
                                key={`${note.path}:${note.description}`}
                                className="body-note-input"
                                defaultValue={note.description}
                                placeholder="添加说明"
                                title={note.path}
                                aria-label={`${note.path} 字段说明`}
                                spellCheck={false}
                                onBlur={(event) =>
                                  commitBodyNote(note.path, event.target.value)
                                }
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault();
                                    event.currentTarget.blur();
                                  }
                                }}
                              />
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </aside>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface RequestGraphqlPanelProps {
  gqlQuery: string;
  onGqlQueryChange: (value: string) => void;
  gqlVariables: string;
  onGqlVariablesChange: (value: string) => void;
  onOpenSchema: () => void;
}

/** GraphQL 请求的 Query 与 Variables 编辑器。 */
export function RequestGraphqlPanel({
  gqlQuery,
  onGqlQueryChange,
  gqlVariables,
  onGqlVariablesChange,
  onOpenSchema,
}: RequestGraphqlPanelProps) {
  return (
    <div className="body-editor gql-editor">
      <div className="editor-toolbar">
        <span className="editor-note">POST · application/json · GraphQL</span>
        <div className="editor-toolbar-spacer" />
        <Button
          variant="text"
          size="small"
          icon={<GlobalOutlined />}
          color="geekblue"
          onClick={onOpenSchema}
        >
          获取 Schema
        </Button>
      </div>
      <label className="gql-field">
        <span>Query</span>
        <Input.TextArea
          value={gqlQuery}
          onChange={(event) => onGqlQueryChange(event.target.value)}
          autoSize={{ minRows: 5, maxRows: 12 }}
          spellCheck={false}
          aria-label="GraphQL Query"
        />
      </label>
      <label className="gql-field">
        <span>Variables</span>
        <Input.TextArea
          value={gqlVariables}
          onChange={(event) => onGqlVariablesChange(event.target.value)}
          autoSize={{ minRows: 3, maxRows: 8 }}
          spellCheck={false}
          aria-label="GraphQL Variables"
        />
      </label>
    </div>
  );
}
