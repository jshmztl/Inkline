import { useEffect, useMemo, useState } from 'react';
import { Button, Empty, Input, Modal, Spin, Table, Tag, theme } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { formatTypeRef, type GraphqlField, type GraphqlType } from '../lib/graphql';

interface GraphqlSchemaModalProps {
  open: boolean;
  loading: boolean;
  error: string;
  types: GraphqlType[];
  onClose: () => void;
  onRefresh: () => void;
}

const columns = [
  {
    title: '字段',
    dataIndex: 'name',
    width: 200,
    render: (name: string) => <code>{name}</code>,
  },
  {
    title: '类型',
    dataIndex: 'type',
    width: 240,
    render: (type: GraphqlField['type']) => <code>{formatTypeRef(type)}</code>,
  },
  {
    title: '说明',
    dataIndex: 'description',
    render: (value?: string | null) => value || '—',
  },
];

export function GraphqlSchemaModal({
  open,
  loading,
  error,
  types,
  onClose,
  onRefresh,
}: GraphqlSchemaModalProps) {
  const { token } = theme.useToken();
  const [query, setQuery] = useState('');
  const [selectedName, setSelectedName] = useState('');

  const filtered = useMemo(
    () =>
      types.filter((type) =>
        type.name.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [types, query],
  );

  const selected =
    filtered.find((type) => type.name === selectedName) ?? filtered[0] ?? null;

  useEffect(() => {
    if (selected && selected.name !== selectedName) {
      setSelectedName(selected.name);
    }
  }, [selected, selectedName]);

  const rows: GraphqlField[] =
    selected?.fields ?? selected?.inputFields ?? [];

  return (
    <Modal
      open={open}
      title="GraphQL Schema"
      width={860}
      onCancel={onClose}
      footer={[
        <Button key="refresh" size="small" icon={<ReloadOutlined />} onClick={onRefresh}>
          重新获取
        </Button>,
        <Button key="close" size="small" type="primary" onClick={onClose}>
          关闭
        </Button>,
      ]}
    >
      {loading ? (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <Spin /> <span style={{ marginLeft: 8 }}>正在获取 introspection…</span>
        </div>
      ) : error ? (
        <div className="update-error">{error}</div>
      ) : types.length === 0 ? (
        <Empty description="未获取到类型定义" />
      ) : (
        <div style={{ display: 'flex', gap: 16, height: 460 }}>
          <div style={{ width: 220, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Input
              size="small"
              allowClear
              placeholder="搜索类型"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div style={{ flex: 1, overflow: 'auto' }}>
              {filtered.map((type) => (
                <button
                  key={type.name}
                  type="button"
                  onClick={() => setSelectedName(type.name)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 8px',
                    border: 'none',
                    borderRadius: 6,
                    cursor: 'pointer',
                    color: 'inherit',
                    background:
                      selected?.name === type.name
                        ? token.colorFillSecondary
                        : 'transparent',
                  }}
                >
                  {type.name}
                </button>
              ))}
            </div>
          </div>

          <div style={{ flex: 1, overflow: 'auto' }}>
            {selected ? (
              <>
                <div style={{ marginBottom: 12 }}>
                  <strong>{selected.name}</strong>{' '}
                  <Tag>{selected.kind}</Tag>
                  {selected.description && (
                    <p style={{ margin: '6px 0 0', opacity: 0.75 }}>
                      {selected.description}
                    </p>
                  )}
                </div>

                {selected.enumValues?.length ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {selected.enumValues.map((value) => (
                      <Tag key={value.name} title={value.description ?? undefined}>
                        {value.name}
                      </Tag>
                    ))}
                  </div>
                ) : rows.length > 0 ? (
                  <Table
                    size="small"
                    pagination={false}
                    rowKey={(row) => row.name}
                    dataSource={rows}
                    columns={columns}
                  />
                ) : (
                  <Empty description="该类型没有字段" />
                )}
              </>
            ) : (
              <Empty description="请选择类型" />
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
