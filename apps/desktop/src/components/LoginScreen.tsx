import { useState } from 'react';
import { LockOutlined, SafetyCertificateOutlined, WifiOutlined } from '@ant-design/icons';
import { App, Button, Input } from 'antd';
import { signIn, type Session } from '../lib/session';

interface LoginScreenProps {
  onSignedIn: (session: Session) => void;
}

export function LoginScreen({ onSignedIn }: LoginScreenProps) {
  const { message } = App.useApp();
  const [account, setAccount] = useState('admin@internal');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  function submit() {
    const result = signIn(account, password);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setError('');
    message.success(`已解锁 ${result.workspace}`);
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
            <strong>API Workbench</strong>
            <span>支付中台 · 私有部署</span>
          </div>
        </div>

        <div className="login-brand-copy">
          <span className="login-eyebrow">INTERNAL WORKSPACE</span>
          <h1>内网接口工作台</h1>
          <p>请求调试、文档生成与团队同步，全部运行在私有网络内。</p>

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

        <span className="login-foot">v0.1 · 内网构建 · 数据不出域</span>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <h2>解锁团队工作区</h2>
          <p>使用团队账号登录。首次登录会在本机建立工作区缓存。</p>

          <div className="login-field">
            <label htmlFor="login-account">账号</label>
            <Input
              id="login-account"
              size="middle"
              value={account}
              onChange={(event) => setAccount(event.target.value)}
              placeholder="name@internal"
              autoComplete="username"
            />
          </div>

          <div className="login-field">
            <label htmlFor="login-password">口令</label>
            <Input.Password
              id="login-password"
              size="middle"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onPressEnter={submit}
              placeholder="输入工作区口令"
              autoComplete="current-password"
            />
          </div>

          {error && <span className="login-error">{error}</span>}

          <Button type="primary" block onClick={submit} disabled={!account.trim() || !password}>
            解锁工作区
          </Button>

          <div className="login-hint">
            演示账号：<code>admin@internal</code> / <code>demo1234</code>
            <br />
            接口开发：<code>dev@internal</code> / <code>demo1234</code>
          </div>
        </div>
      </section>
    </div>
  );
}
