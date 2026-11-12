import type { ChangeEvent } from 'react';
import {
  BookOutlined,
  DownOutlined,
  ExperimentOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Button, Checkbox, Dropdown, Input, Tag, Tooltip } from 'antd';
import type { DocTask, FieldReview } from '../lib/docTask';

interface AiReviewCardProps {
  task: DocTask | null;
  review: FieldReview[];
  pending: number;
  accepted: Record<string, boolean>;
  notes: Record<string, string>;
  applied: boolean;
  descLoading: boolean;
  testsLoading: boolean;
  onAcceptedChange: (key: string, checked: boolean) => void;
  onNoteChange: (key: string, value: string) => void;
  onOpenGlossary: () => void;
  onApply: () => void;
  onGenerateDescriptions: () => void;
  onGenerateTests: () => void;
  onOpenDiff: () => void;
  onExport: (format: 'markdown' | 'openapi') => void;
  onIgnore: () => void;
}

// 字段审阅卡片：逐项确认字段说明并应用到文档草稿。
export function AiReviewCard({
  task,
  review,
  pending,
  accepted,
  notes,
  applied,
  descLoading,
  testsLoading,
  onAcceptedChange,
  onNoteChange,
  onOpenGlossary,
  onApply,
  onGenerateDescriptions,
  onGenerateTests,
  onOpenDiff,
  onExport,
  onIgnore,
}: AiReviewCardProps) {
  const requestReview = review.filter((item) => item.source === '请求');
  const responseReview = review.filter((item) => item.source === '响应');

  function renderReviewRow(field: FieldReview) {
    return (
      <div className="review-row" key={field.key}>
        <Checkbox
          checked={accepted[field.key] ?? true}
          onChange={(event) => onAcceptedChange(field.key, event.target.checked)}
        />
        <div className="review-field">
          <div>
            <code>{field.path}</code>
            <em>{field.type}</em>
            <b className={`review-source${field.source === '请求' ? ' req' : ' res'}`}>
              {field.source}
            </b>
          </div>
          <Input.TextArea
            className="review-note-input"
            value={notes[field.key] ?? field.note}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
              onNoteChange(field.key, event.target.value)
            }
            placeholder="补充字段说明（可留空）"
            aria-label={`${field.path} 字段说明`}
            autoSize={{ minRows: 1, maxRows: 3 }}
            variant="borderless"
          />
        </div>
        <div className="confidence">
          <div className="confidence-bar">
            <i
              className={field.confidence < 90 ? 'low' : undefined}
              style={{ width: `${field.confidence}%` }}
            />
          </div>
          <span>{field.confidence}%</span>
        </div>
      </div>
    );
  }

  return (
    <div className="review-card">
      <div className="review-head">
        <strong>字段审阅</strong>
        <span>
          {task ? `${pending} 项待确认 · 共 ${review.length} 字段` : '等待文档任务'}
        </span>
        <Tooltip title="维护字段术语表">
          <Button
            className="review-glossary-btn"
            variant="text"
            size="small"
            color="geekblue"
            icon={<BookOutlined />}
            onClick={onOpenGlossary}
            aria-label="维护字段术语表"
          />
        </Tooltip>
        {applied && <Tag className="applied-tag">已应用</Tag>}
      </div>

      {requestReview.length > 0 && (
        <>
          <div className="review-group">
            <span>请求参数</span>
            <em>{requestReview.length}</em>
          </div>
          {requestReview.map(renderReviewRow)}
        </>
      )}

      {responseReview.length > 0 && (
        <>
          <div className="review-group">
            <span>响应字段</span>
            <em>{responseReview.length}</em>
          </div>
          {responseReview.map(renderReviewRow)}
        </>
      )}

      {review.length === 0 && (
        <div className="review-empty">等待请求上下文后生成字段审阅。</div>
      )}

      <div className="review-actions">
        <Button
          color="green"
          variant="solid"
          size="small"
          onClick={onApply}
          disabled={applied || review.length === 0}
        >
          {applied ? '已应用' : '应用到文档'}
        </Button>
        <Button
          size="small"
          color="geekblue"
          variant="filled"
          icon={<ThunderboltOutlined />}
          loading={descLoading}
          onClick={onGenerateDescriptions}
          disabled={review.length === 0}
        >
          AI 生成说明
        </Button>
        <Button
          size="small"
          color="orange"
          variant="filled"
          icon={<ExperimentOutlined />}
          loading={testsLoading}
          onClick={onGenerateTests}
          disabled={!task}
        >
          生成测试用例
        </Button>
        <Button size="small" onClick={onOpenDiff}>
          查看 diff
        </Button>
        <Dropdown
          trigger={['click']}
          disabled={!task}
          menu={{
            items: [
              { key: 'markdown', label: '导出 Markdown' },
              { key: 'openapi', label: '导出 OpenAPI' },
            ],
            onClick: ({ key }) => onExport(key as 'markdown' | 'openapi'),
          }}
        >
          <Button size="small" disabled={!task}>
            导出 <DownOutlined />
          </Button>
        </Dropdown>
        <Button type="text" size="small" onClick={onIgnore}>
          忽略
        </Button>
      </div>
    </div>
  );
}
