import type { Dispatch, SetStateAction } from 'react';
import { App, Input, Modal } from 'antd';
import type { CollectionEditorState } from './CollectionTree';

interface CollectionEditorModalProps {
  editor: CollectionEditorState | null;
  onChange: Dispatch<SetStateAction<CollectionEditorState | null>>;
  onClose: () => void;
  onCreateCollection: (name: string, parentId?: string) => Promise<string>;
  onCreateRequest: (collectionId: string) => Promise<void>;
  onRenameCollection: (id: string, name: string) => Promise<void>;
  onRenameRequest: (id: string, name: string) => Promise<void>;
}

/** 集合/请求的新建与重命名弹窗。 */
export function CollectionEditorModal({
  editor,
  onChange,
  onClose,
  onCreateCollection,
  onCreateRequest,
  onRenameCollection,
  onRenameRequest,
}: CollectionEditorModalProps) {
  const { message } = App.useApp();

  async function submitEditor() {
    if (!editor) return;
    const name = editor.value.trim();
    if (!name) {
      message.warning('名称不能为空');
      return;
    }
    try {
      if (editor.mode === 'create') {
        await onCreateCollection(name, editor.parentId);
      } else if (editor.mode === 'create-request') {
        const collectionId = await onCreateCollection(name);
        await onCreateRequest(collectionId);
      } else if (editor.mode === 'rename-collection' && editor.id) {
        await onRenameCollection(editor.id, name);
      } else if (editor.mode === 'rename-request' && editor.id) {
        await onRenameRequest(editor.id, name);
      }
      onClose();
      message.success('已保存');
    } catch {
      message.error('保存失败，请稍后重试');
    }
  }

  return (
    <Modal
      open={editor !== null}
      title={
        editor?.mode === 'create'
          ? '新建集合'
          : editor?.mode === 'create-request'
            ? '新建集合与请求'
            : editor?.mode === 'rename-collection'
              ? '重命名集合'
              : '重命名请求'
      }
      width={380}
      okText="保存"
      cancelText="取消"
      onCancel={onClose}
      onOk={submitEditor}
    >
      <Input
        autoFocus
        value={editor?.value ?? ''}
        onChange={(event) =>
          onChange((current) => (current ? { ...current, value: event.target.value } : current))
        }
        onPressEnter={submitEditor}
        placeholder="名称"
        aria-label="名称"
      />
    </Modal>
  );
}
