import { useState } from 'react';
import {
  LockOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
  WifiOutlined,
} from '@ant-design/icons';
import { Button, Input } from 'antd';
import { enterLocal, enterTeam, type Session } from '../lib/session';

interface LoginScreenProps {
  onSignedIn: (session: Session) => void;
}

export function LoginScreen({ onSignedIn }: LoginScreenProps) {
  const [teamName, setTeamName] = useState('');
  const [memberName, setMemberName] = useState('');
  const [error, setError] = useState('');

  function handleLocal() {
    setError('');
    onSignedIn(enterLocal());
  }

  function handleTeam() {
    const result = enterTeam(teamName, memberName);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setError('');
    onSignedIn(result);
  }

  return (
    <div className="login-screen">
      <section className="login-brand">
        <div className="login-brand-head">
          <div className="brand-glyph" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </div>
          <div className="brand-text">
            <strong>墨线 Inkline</strong>
            <span>本机 · 私有部署</span>
          </div>
        </div>

        <div className="login-brand-copy">
          <span className="login-eyebrow">INTERNAL WORKSPACE</span>
          <h1>内网接口工作台</h1>
          <p>请求调试、文档生成与本地快照，全部运行在私有网络内。</p>

          <ul className="login-points">
            <li>
              <LockOutlined />
              <div>
                <strong>本地优先</strong>
                <span>历史、集合与草稿存放在本机，离线可用。</span>
              </div>
            </li>
            <li>
              <WifiOutlined />
              <div>
                <strong>分级出网</strong>
                <span>L2 / L3 数据默认不出网，出网需脱敏与审批。</span>
              </div>
            </li>
            <li>
              <SafetyCertificateOutlined />
              <div>
                <strong>可审计</strong>
                <span>请求、AI 任务与出网记录均可追溯。</span>
              </div>
            </li>
          </ul>
        </div>

        <span className="login-foot">v{__APP_VERSION__} · 内网构建 · 数据不出域</span>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <h2>进入工作区</h2>
          <p>不需要账号口令。个人使用直接进入；团队使用填写团队与成员信息。</p>

          <Button type="primary" size="large" block onClick={handleLocal}>
            直接进入本机工作区
          </Button>

          <div className="login-divider">或使用团队工作区</div>

          <div className="login-field">
            <label htmlFor="login-team">团队名称</label>
            <Input
              id="login-team"
              size="middle"
              value={teamName}
              maxLength={40}
              onChange={(event) => setTeamName(event.target.value)}
              onPressEnter={handleTeam}
              placeholder="例如：支付中台"
              autoComplete="organization"
            />
          </div>

          <div className="login-field">
            <label htmlFor="login-member">成员名称</label>
            <Input
              id="login-member"
              size="middle"
              value={memberName}
              maxLength={40}
              onChange={(event) => setMemberName(event.target.value)}
              onPressEnter={handleTeam}
              placeholder="例如：张三"
              autoComplete="name"
            />
          </div>

          {error && <span className="login-error">{error}</span>}

          <Button
            block
            icon={<TeamOutlined />}
            onClick={handleTeam}
            disabled={!teamName.trim() || !memberName.trim()}
          >
            进入团队工作区
          </Button>

          <div className="login-hint">
            本机模式不校验身份。团队信息仅用于本机标识、审计与快照记录，不会上传；跨机同步需接入团队服务。
          </div>
        </div>
      </section>
    </div>
  );
}
