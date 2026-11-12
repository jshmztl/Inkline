import { useEffect, useState } from 'react';
import { App, Button, Input, Space, Tag } from 'antd';
import {
  clearTeamKey,
  generateTeamKey,
  isValidTeamKey,
  keyFingerprint,
  readTeamKey,
  saveTeamKey,
} from '../lib/teamCrypto';

interface TeamEncryptionPanelProps {
  teamId: string;
}

export function TeamEncryptionPanel({ teamId }: TeamEncryptionPanelProps) {
  const { message, modal } = App.useApp();
  const [key, setKey] = useState('');
  const [draft, setDraft] = useState('');
  const [fingerprint, setFingerprint] = useState('');

  useEffect(() => {
    const info = readTeamKey(teamId);
    setKey(info?.key ?? '');
    setDraft('');
    setFingerprint('');
    if (info) void keyFingerprint(info.key).then(setFingerprint);
  }, [teamId]);

  async function applyKey(next: string, success: string) {
    const info = saveTeamKey(teamId, next);
    setKey(info.key);
    setDraft(info.key);
    setFingerprint(await keyFingerprint(info.key));
    message.success(success);
  }

  async function generate() {
    const next = await generateTeamKey();
    await applyKey(next, '已生成团队密钥，请通过安全渠道分享给其他成员');
  }

  function importKey() {
    try {
      void applyKey(draft, '已导入团队密钥');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '团队密钥无效');
    }
  }

  function copyKey() {
    void navigator.clipboard.writeText(key).then(
      () => message.success('团队密钥已复制'),
      () => message.error('复制失败，请手动选择密钥复制'),
    );
  }

  function removeKey() {
    modal.confirm({
      title: '清除团队密钥？',
      content: '清除后无法推送或拉取已加密的团队快照，需要重新导入同一密钥。',
      okText: '清除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => {
        clearTeamKey(teamId);
        setKey('');
        setDraft('');
        setFingerprint('');
        message.success('已清除团队密钥');
      },
    });
  }

  return (
    <div className="team-crypto">
      <div className="team-crypto-head">
        <strong>端到端加密</strong>
        {key ? <Tag color="green">已启用</Tag> : <Tag>未启用</Tag>}
      </div>
      <p className="team-crypto-note">
        启用后，请求头、请求体与字段文档在客户端加密后再上传，服务端只保存密文。集合与接口名称、方法保持明文，用于权限裁剪和目录展示。
      </p>

      {key ? (
        <>
          <div className="login-field">
            <label>密钥指纹</label>
            <Input value={fingerprint} readOnly />
          </div>
          <div className="login-field">
            <label>团队密钥</label>
            <Input.Password value={key} readOnly />
          </div>
          <Space wrap>
            <Button size="small" onClick={copyKey}>
              复制密钥
            </Button>
            <Button size="small" onClick={() => void generate()}>
              重新生成
            </Button>
            <Button size="small" danger onClick={removeKey}>
              清除密钥
            </Button>
          </Space>
        </>
      ) : (
        <>
          <div className="login-field">
            <label>粘贴团队密钥</label>
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="32 字节 Base64 密钥"
            />
          </div>
          <Space wrap>
            <Button
              size="small"
              type="primary"
              disabled={!isValidTeamKey(draft)}
              onClick={importKey}
            >
              导入密钥
            </Button>
            <Button size="small" onClick={() => void generate()}>
              生成新密钥
            </Button>
          </Space>
        </>
      )}
    </div>
  );
}
