import { useEffect, useState } from 'react';
import { App, Button, Input, Space, Tag } from 'antd';
import {
  clearTeamKey,
  keyFingerprint,
  readTeamKey,
} from '../lib/teamCrypto';
import {
  ensureTeamEncryption,
  rotateTeamEncryption,
  type TeamEncryptionResult,
} from '../lib/teamE2E';
import { readTeamConnection } from '../lib/teamClient';

interface TeamEncryptionPanelProps {
  teamId: string;
  role: string;
}

export function TeamEncryptionPanel({ teamId, role }: TeamEncryptionPanelProps) {
  const { message, modal } = App.useApp();
  const [result, setResult] = useState<TeamEncryptionResult | null>(null);
  const [fingerprint, setFingerprint] = useState('');
  const [legacyKey, setLegacyKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isManager = role === 'owner' || role === 'admin';
  const status = result?.status;
  const pending = result?.pending ?? false;

  async function refresh() {
    const connection = readTeamConnection();
    if (!connection) {
      setError('团队连接已失效，请重新登录');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const next = await ensureTeamEncryption(connection, teamId, role);
      setResult(next);
      const currentKey = next.keyring.keys.get(next.keyring.currentVersion);
      setFingerprint(currentKey ? await keyFingerprint(currentKey) : '');
      setLegacyKey(readTeamKey(teamId)?.key ?? null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : '团队加密初始化失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, role]);

  function rotate() {
    modal.confirm({
      title: '轮换团队密钥？',
      content:
        '轮换后新快照使用新密钥，旧快照仍可用历史密钥解密。请确保其他成员已经同步，否则可能产生版本冲突；如果当前设备缺少历史密钥，旧快照可能无法在本机解密。',
      okText: '轮换',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const connection = readTeamConnection();
        if (!connection) {
          message.error('团队连接已失效，请重新登录');
          return;
        }
        setLoading(true);
        try {
          const next = await rotateTeamEncryption(connection, teamId, role);
          setResult(next);
          const currentKey = next.keyring.keys.get(next.keyring.currentVersion);
          setFingerprint(currentKey ? await keyFingerprint(currentKey) : '');
          message.success(`团队密钥已轮换到 v${next.status.currentVersion}`);
        } catch (rotateError) {
          message.error(
            rotateError instanceof Error ? rotateError.message : '轮换团队密钥失败',
          );
        } finally {
          setLoading(false);
        }
      },
    });
  }

  function removeLegacyKey() {
    modal.confirm({
      title: '清除旧手动密钥？',
      content: '清除后可能无法解密历史手动加密快照，请确认已不再需要这些历史版本。',
      okText: '清除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => {
        clearTeamKey(teamId);
        setLegacyKey(null);
        message.success('已清除旧手动密钥');
      },
    });
  }

  return (
    <div className="team-crypto">
      <div className="team-crypto-head">
        <strong>端到端加密</strong>
        {pending ? (
          <Tag color="orange">等待密钥</Tag>
        ) : status?.enabled ? (
          <Tag color="green">已启用</Tag>
        ) : (
          <Tag>未启用</Tag>
        )}
      </div>
      <p className="team-crypto-note">
        团队密钥由管理员设备生成并分发给成员设备，服务端只保存成员公钥与包裹后的密钥，无法解密快照内容。首次启用或轮换密钥后，需要由所有者或管理员推送一次完整快照。
      </p>
      {isManager && (
        <p className="team-crypto-note">
          移除成员后建议立即轮换团队密钥，避免其保留的历史密钥继续解密旧快照。
        </p>
      )}

      {error && <span className="login-error">{error}</span>}

      {status && !status.enabled && (
        <p className="team-crypto-note">
          服务端尚未启用端到端加密，当前团队快照仍为服务端可读。请先升级团队服务。
        </p>
      )}

      {status && (
        <>
          <div className="login-field">
            <label>密钥版本</label>
            <Input
              value={status.currentVersion > 0 ? `v${status.currentVersion}` : '尚未创建'}
              readOnly
            />
          </div>
          {status.currentVersion > 0 &&
            result?.keyring.keys.has(status.currentVersion) && (
            <div className="login-field">
              <label>密钥指纹</label>
              <Input value={fingerprint} readOnly />
            </div>
          )}
          <div className="login-field">
            <label>当前设备</label>
            <Input
              value={
                status.device?.deviceId
                  ? status.device.deviceId.slice(0, 8)
                  : '尚未注册'
              }
              readOnly
            />
          </div>

          {pending && (
            <p className="team-crypto-note">
              当前设备还没有获得团队密钥。请联系团队所有者或管理员登录后分发，然后点击刷新密钥。
            </p>
          )}

          {isManager && status.devices.length > 0 && (
            <div className="team-crypto-devices">
              <div className="team-crypto-device-head">
                <span>成员设备</span>
                <em>{status.pendingDevices} 台待分发</em>
              </div>
              {status.devices.map((device) => (
                <div className="team-crypto-device" key={device.deviceId}>
                  <span>{device.displayName || device.userId.slice(0, 8)}</span>
                  <code>{device.deviceId.slice(0, 8)}</code>
                  <Tag color={device.hasCurrentKey ? 'green' : 'orange'}>
                    {device.hasCurrentKey ? '已分发' : '待分发'}
                  </Tag>
                </div>
              ))}
            </div>
          )}

          <Space wrap>
            <Button size="small" loading={loading} onClick={() => void refresh()}>
              刷新密钥
            </Button>
            {isManager && status.currentVersion > 0 && (
              <Button size="small" danger loading={loading} onClick={rotate}>
                轮换团队密钥
              </Button>
            )}
          </Space>
        </>
      )}

      {!status && loading && <p className="team-crypto-note">正在初始化端到端加密…</p>}

      {legacyKey && (
        <div className="team-crypto-legacy">
          <strong>旧手动密钥</strong>
          <p>仅用于解密历史快照，新快照统一使用服务端分发的团队密钥。</p>
          <Button size="small" danger onClick={removeLegacyKey}>
            清除旧密钥
          </Button>
        </div>
      )}
    </div>
  );
}
