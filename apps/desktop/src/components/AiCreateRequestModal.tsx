import { Button, Input, Modal, Select } from 'antd';
import type { HttpMethod } from '../data/types';
import type { Collection } from '../lib/api';
import { httpMethods, type RequestDraft } from '../lib/requestDraft';

interface AiCreateRequestModalProps {
  draftRequest: RequestDraft | null;
  collections: Collection[];
  collectionId: string;
  creating: boolean;
  onClose: () => void;
  onCollectionChange: (collectionId: string) => void;
  onDraftChange: (draft: RequestDraft) => void;
  onCreate: () => void;
}

// 从文档识别结果创建接口的确认弹窗。
export function AiCreateRequestModal({
  draftRequest,
  collections,
  collectionId,
  creating,
  onClose,
  onCollectionChange,
  onDraftChange,
  onCreate,
}: AiCreateRequestModalProps) {
  return (
    <Modal
      open={draftRequest !== null}
      title="从文档创建接口"
      width={640}
      onCancel={onClose}
      footer={[
        <Button key="cancel" size="small" onClick={onClose}>
          取消
        </Button>,
        <Button
          key="create"
          size="small"
          type="primary"
          loading={creating}
          disabled={!draftRequest || !draftRequest.url.trim()}
          onClick={onCreate}
        >
          创建接口
        </Button>,
      ]}
    >
      {draftRequest && (
        <>
          <p className="draft-tip">
            AI 已从文档中提取以下接口，确认后会加入所选集合并自动打开。
            {collections.length === 0 && '当前还没有集合，创建时会自动新建「AI 生成接口」集合。'}
          </p>
          <div className="draft-field">
            <label htmlFor="draft-name">接口名称</label>
            <Input
              id="draft-name"
              value={draftRequest.name}
              maxLength={60}
              onChange={(event) =>
                onDraftChange({ ...draftRequest, name: event.target.value })
              }
            />
          </div>
          <div className="draft-row">
            <div className="draft-field">
              <label>请求方法</label>
              <Select<HttpMethod>
                value={draftRequest.method}
                onChange={(method) => onDraftChange({ ...draftRequest, method })}
                options={httpMethods.map((method) => ({ value: method, label: method }))}
              />
            </div>
            <div className="draft-field">
              <label>所属集合</label>
              <Select
                value={collectionId || undefined}
                onChange={(value: string) => onCollectionChange(value)}
                placeholder={collections.length > 0 ? '选择集合' : '将新建「AI 生成接口」集合'}
                disabled={collections.length === 0}
                options={collections.map((collection) => ({
                  value: collection.id,
                  label: collection.name,
                }))}
              />
            </div>
          </div>
          <div className="draft-field">
            <label htmlFor="draft-url">请求地址</label>
            <Input
              id="draft-url"
              value={draftRequest.url}
              onChange={(event) =>
                onDraftChange({ ...draftRequest, url: event.target.value })
              }
            />
          </div>
          <div className="preflight">
            <div className="preflight-row">
              <span>请求头</span>
              <b>{draftRequest.headers.length} 项</b>
            </div>
            {draftRequest.headers.length > 0 && (
              <div className="preflight-masks">
                {draftRequest.headers.map((header, index) => (
                  <div className="preflight-mask" key={`${header.name}-${index}`}>
                    <code>{header.name}</code>
                    <span>{header.value || '（空）'}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="preflight-row">
              <span>请求体</span>
              <b>{draftRequest.body ? `${draftRequest.body.length} 字符` : '无'}</b>
            </div>
          </div>
          {draftRequest.body && (
            <pre className="doc-preview draft-body">{draftRequest.body}</pre>
          )}
          <p className="draft-tip">创建后可在请求面板中继续调整参数、认证与脚本。</p>
        </>
      )}
    </Modal>
  );
}
