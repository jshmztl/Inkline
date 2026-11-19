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
import {
  disableTeamServerReview,
  enableTeamServerReview,
  readTeamConnection,
} from '../lib/teamClient';

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

  function toggleServerReview() {
    if (!status) return;
    const connection = readTeamConnection();
    if (!connection) {
      message.error('团队连接已失效，请重新登录');
      return;
    }
    const enabling = !status.serverReview.teamEnabled;
    modal.confirm({
      title: enabling ? '开启服务端审阅？' : '关闭服务端审阅？',
      content: enabling
        ? '开启后，管理台可在服务端解密查看请求头、请求体与字段文档；所有查看会写入审计。'
        : '关闭后立即删除服务端托管副本，管理台无法再查看参数；设备端解密和团队同步不受影响。',
      okText: enabling ? '开启' : '关闭',
      okButtonProps: enabling ? undefined : { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setLoading(true);
        try {
          if (enabling) {
            await enableTeamServerReview(connection, teamId);
          } else {
            await disableTeamServerReview(connection, teamId);
          }
          message.success(enabling ? '已开启服务端审阅' : '已关闭服务端审阅');
          await refresh();
        } catch (actionError) {
          message.error(
            actionError instanceof Error ? actionError.message : '操作失败',
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
        团队密钥由管理员设备生成并分发给成员设备。为支持管理台审阅，服务端会保存一份受控托管的团队密钥副本，仅用于解密请求头、请求体和字段文档；成员电脑之间仍使用端到端加密。
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
          <div className="login-field">
            <label>服务端审阅</label>
            <Input
              value={
                !status.serverReview.featureEnabled
                  ? '服务端未配置审阅主密钥'
                  : !status.serverReview.teamEnabled
                    ? '团队已关闭'
                    : status.currentVersion > 0 &&
                        status.serverReview.versions.includes(status.currentVersion)
                      ? '已托管 · 管理台可查看参数'
                      : '未托管'
              }
              readOnly
            />
          </div>
          {status.enabled &&
            status.serverReview.enabled &&
            status.currentVersion > 0 &&
            !status.serverReview.versions.includes(status.currentVersion) && (
              <p className="team-crypto-note">
                服务端尚未托管当前团队密钥，管理台暂时只能看到接口目录。所有者或管理员登录后会自动完成托管。
              </p>
            )}
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
            {isManager &&
              status.currentVersion > 0 &&
              status.serverReview.featureEnabled && (
                <Button
                  size="small"
                  danger={status.serverReview.teamEnabled}
                  loading={loading}
                  onClick={toggleServerReview}
                >
                  {status.serverReview.teamEnabled
                    ? '关闭服务端审阅'
                    : '开启服务端审阅'}
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
