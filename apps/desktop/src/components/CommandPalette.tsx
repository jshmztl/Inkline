import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ApiOutlined, GlobalOutlined, SearchOutlined } from '@ant-design/icons';
import { Input, Modal } from 'antd';
import {
  environmentVariables,
  environments,
  networkModes,
  type ApiRequest,
  type NetworkMode,
} from '../data/mock';
import { MethodTag } from './MethodTag';

interface CommandPaletteProps {
  open: boolean;
  requests: ApiRequest[];
  onClose: () => void;
  onSelectRequest: (request: ApiRequest) => void;
  onEnvironmentChange: (environment: string) => void;
  onNetworkModeChange: (mode: NetworkMode) => void;
}

interface Command {
  id: string;
  group: string;
  title: string;
  hint?: string;
  method?: string;
  icon?: 'environment' | 'network';
  run: () => void;
}

export function CommandPalette({
  open,
  requests,
  onClose,
  onSelectRequest,
  onEnvironmentChange,
  onNetworkModeChange,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const commands: Command[] = [
    ...(Object.keys(networkModes) as NetworkMode[]).map((mode) => ({
      id: `network-${mode}`,
      group: '模式',
      title: `切换到 ${networkModes[mode].label}`,
      hint: networkModes[mode].description,
      icon: 'network' as const,
      run: () => {
        onNetworkModeChange(mode);
        onClose();
      },
    })),
    ...environments.map((item) => ({
      id: `env-${item.value}`,
      group: '环境',
      title: `切换到 ${item.label}`,
      hint: environmentVariables[item.value]?.host,
      icon: 'environment' as const,
      run: () => {
        onEnvironmentChange(item.value);
        onClose();
      },
    })),
    ...requests.map((request) => ({
      id: `request-${request.id}`,
      group: '请求',
      title: `${request.method} ${request.path}`,
      hint: request.name,
      method: request.method,
      run: () => {
        onSelectRequest(request);
        onClose();
      },
    })),
  ];

  const keyword = query.trim().toLowerCase();
  const filtered = keyword
    ? commands.filter((command) =>
        `${command.group} ${command.title} ${command.hint ?? ''}`
          .toLowerCase()
          .includes(keyword),
      )
    : commands;

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [keyword]);

  useEffect(() => {
    const node = listRef.current?.querySelector('[data-active="true"]');
    node?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, filtered.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      filtered[active]?.run();
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={520}
      className="command-modal"
      styles={{ body: { padding: 0 } }}
    >
      <div className="command-palette">
        <label className="command-search">
          <SearchOutlined />
          <Input
            variant="borderless"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索请求、环境或模式…"
            aria-label="命令面板搜索"
          />
          <kbd>ESC</kbd>
        </label>

        <div className="command-list" ref={listRef} role="listbox">
          {filtered.length === 0 ? (
            <div className="command-empty">没有匹配的命令。</div>
          ) : (
            filtered.map((command, index) => {
              const showGroup = index === 0 || filtered[index - 1].group !== command.group;
              return (
                <div key={command.id}>
                  {showGroup && <div className="command-group">{command.group}</div>}
                  <button
                    type="button"
                    className={`command-item${index === active ? ' active' : ''}`}
                    data-active={index === active}
                    onMouseEnter={() => setActive(index)}
                    onClick={command.run}
                    role="option"
                    aria-selected={index === active}
                  >
                    {command.method ? (
                      <MethodTag method={command.method as ApiRequest['method']} />
                    ) : (
                      <span className="command-icon">
                        {command.icon === 'network' ? <ApiOutlined /> : <GlobalOutlined />}
                      </span>
                    )}
                    <span className="command-title">{command.title}</span>
                    {command.hint && <span className="command-hint">{command.hint}</span>}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="command-foot">
          <span>↑↓ 选择</span>
          <span>↵ 执行</span>
          <span>esc 关闭</span>
          <em>⌘K</em>
        </div>
      </div>
    </Modal>
  );
}
