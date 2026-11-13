import { useState } from 'react';
import {
  LockOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
  WifiOutlined,
} from '@ant-design/icons';
import { Button, Input } from 'antd';
import { enterLocal, enterTeamSession, type Session } from '../lib/session';
import {
  changeTeamPassword,
  clearTeamConnection,
  createTeamRemote,
  fetchTeams,
  loginTeam,
  readServerHint,
  type RemoteTeam,
  type TeamConnection,
} from '../lib/teamClient';

interface LoginScreenProps {
  onSignedIn: (session: Session) => void;
}

const roleLabels: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  member: '成员',
  viewer: '只读',
};

function passwordProblem(value: string): string | null {
  if (value.length < 8) return '口令至少需要 8 个字符';
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    return '口令需要同时包含字母和数字';
  }
  return null;
}

export function LoginScreen({ onSignedIn }: LoginScreenProps) {
  const [serverUrl, setServerUrl] = useState(() => readServerHint());
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [phase, setPhase] = useState<'form' | 'change' | 'choose'>('form');
  const [connection, setConnection] = useState<TeamConnection | null>(null);
  const [teams, setTeams] = useState<RemoteTeam[]>([]);
  const [newTeamName, setNewTeamName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function enter(team: RemoteTeam) {
    if (!connection) return;
    onSignedIn(
      enterTeamSession(connection.serverUrl, connection.user, {
        id: team.id,
        name: team.name,
        role: team.role,
      }),
    );
  }

  async function handleConnect() {
    if (!serverUrl.trim() || !account.trim() || !password) {
      setError('请填写服务地址、账号与口令');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await loginTeam(serverUrl, account, password);
      setConnection(result.connection);
      setTeams(result.teams);

      if (result.mustChangePassword) {
        setNewPassword('');
        setConfirmPassword('');
        setPhase('change');
        return;
      }

      setPhase('choose');

      if (result.teams.length === 1) {
        onSignedIn(
          enterTeamSession(result.connection.serverUrl, result.connection.user, {
            id: result.teams[0].id,
            name: result.teams[0].name,
            role: result.teams[0].role,
          }),
        );
      }
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : '连接团队服务失败');
      setPhase('form');
    } finally {
      setLoading(false);
    }
  }

  async function handleChangePassword() {
    if (!connection) return;
    const problem = passwordProblem(newPassword);
    if (problem) {
      setError(problem);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的口令不一致');
      return;
    }
    if (newPassword === password) {
      setError('新口令不能与当前口令相同');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const updated = await changeTeamPassword(connection, password, newPassword);
      let nextTeams: RemoteTeam[];
      try {
        nextTeams = await fetchTeams(updated);
      } catch {
        clearTeamConnection();
        setConnection(null);
        setPassword('');
        setNewPassword('');
        setConfirmPassword('');
        setPhase('form');
        setError('口令已修改，请使用新口令重新登录');
        return;
      }

      setConnection(updated);
      setTeams(nextTeams);
      setPassword(newPassword);
      setNewPassword('');
      setConfirmPassword('');
      setPhase('choose');

      if (nextTeams.length === 1) {
        onSignedIn(
          enterTeamSession(updated.serverUrl, updated.user, {
            id: nextTeams[0].id,
            name: nextTeams[0].name,
            role: nextTeams[0].role,
          }),
        );
      }
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : '修改口令失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateTeam() {
    if (!connection) return;
    const name = newTeamName.trim();
    if (!name) {
      setError('请输入团队名称');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const team = await createTeamRemote(connection, name);
      enter(team);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建团队失败');
    } finally {
      setLoading(false);
    }
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
          <p>请求调试、文档生成与团队快照，全部运行在私有网络内。</p>

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
          <p>个人使用直接进入本机；团队使用登录团队服务，同步与权限由服务端统一管理。</p>

          <Button type="primary" size="large" block onClick={() => onSignedIn(enterLocal())}>
            直接进入本机工作区
          </Button>

          <div className="login-divider">或连接团队服务</div>

          {phase === 'form' ? (
            <>
              <div className="login-field">
                <label htmlFor="login-server">服务地址</label>
                <Input
                  id="login-server"
                  size="middle"
                  value={serverUrl}
                  onChange={(event) => setServerUrl(event.target.value)}
                  placeholder="http://192.168.1.10:8080"
                  autoComplete="url"
                />
              </div>

              <div className="login-field">
                <label htmlFor="login-account">账号</label>
                <Input
                  id="login-account"
                  size="middle"
                  value={account}
                  onChange={(event) => setAccount(event.target.value)}
                  placeholder="由团队管理员创建"
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
                  onPressEnter={handleConnect}
                  placeholder="请输入口令"
                  autoComplete="current-password"
                />
              </div>

              {error && <span className="login-error">{error}</span>}

              <Button
                block
                icon={<TeamOutlined />}
                loading={loading}
                onClick={handleConnect}
                disabled={!serverUrl.trim() || !account.trim() || !password}
              >
                登录团队服务
              </Button>

              <div className="login-hint">
                登录后可选择所属团队；账号与成员由团队管理员在管理台维护。团队快照保存在服务端。
              </div>
            </>
          ) : phase === 'change' ? (
            <>
              <div className="login-hint" style={{ marginBottom: 12 }}>
                已连接 {connection?.serverUrl} · {connection?.user.account}。首次登录需要修改初始口令后才能进入工作区。
              </div>

              <div className="login-field">
                <label htmlFor="login-new-password">新口令</label>
                <Input.Password
                  id="login-new-password"
                  size="middle"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  placeholder="至少 8 位，需包含字母和数字"
                  autoComplete="new-password"
                />
              </div>

              <div className="login-field">
                <label htmlFor="login-confirm-password">确认新口令</label>
                <Input.Password
                  id="login-confirm-password"
                  size="middle"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  onPressEnter={handleChangePassword}
                  placeholder="再次输入新口令"
                  autoComplete="new-password"
                />
              </div>

              {error && <span className="login-error">{error}</span>}

              <Button
                type="primary"
                block
                loading={loading}
                onClick={handleChangePassword}
                disabled={!newPassword || !confirmPassword}
              >
                保存并继续
              </Button>

              <Button
                type="link"
                size="small"
                block
                style={{ marginTop: 8 }}
                onClick={() => {
                  clearTeamConnection();
                  setConnection(null);
                  setPassword('');
                  setNewPassword('');
                  setConfirmPassword('');
                  setPhase('form');
                  setError('');
                }}
              >
                返回登录
              </Button>
            </>
          ) : (
            <>
              <div className="login-hint" style={{ marginBottom: 12 }}>
                已连接 {connection?.serverUrl} · {connection?.user.displayName}（
                {connection?.user.account}）
              </div>

              {teams.length > 0 ? (
                <>
                  <div className="login-team-list">
                    {teams.map((team) => (
                      <button
                        key={team.id}
                        type="button"
                        className="login-team-item"
                        onClick={() => enter(team)}
                        disabled={loading}
                      >
                        <div>
                          <strong>{team.name}</strong>
                          <span>
                            {roleLabels[team.role] ?? team.role} · {team.memberCount} 人 · rev #
                            {team.revision}
                          </span>
                        </div>
                        <em>进入</em>
                      </button>
                    ))}
                  </div>

                  {error && <span className="login-error">{error}</span>}
                </>
              ) : (
                <>
                  <div className="login-field">
                    <label htmlFor="login-new-team">创建团队</label>
                    <Input
                      id="login-new-team"
                      size="middle"
                      value={newTeamName}
                      onChange={(event) => setNewTeamName(event.target.value)}
                      onPressEnter={handleCreateTeam}
                      placeholder="例如：支付中台"
                    />
                  </div>

                  {error && <span className="login-error">{error}</span>}

                  <Button
                    type="primary"
                    block
                    icon={<TeamOutlined />}
                    loading={loading}
                    disabled={!newTeamName.trim()}
                    onClick={handleCreateTeam}
                  >
                    创建团队并进入
                  </Button>
                </>
              )}

              <Button
                type="link"
                size="small"
                block
                style={{ marginTop: 8 }}
                onClick={() => {
                  clearTeamConnection();
                  setConnection(null);
                  setPhase('form');
                  setError('');
                }}
              >
                使用其他账号
              </Button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
