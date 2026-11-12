import { beforeEach, describe, expect, it } from 'vitest';
import { kvSet } from './kv';
import { enterLocal, enterTeamSession, readSession, signOut } from './session';

describe('session', () => {
  beforeEach(() => {
    signOut();
  });

  it('直接进入本机工作区，不校验账号口令', () => {
    const session = enterLocal();

    expect(session.mode).toBe('local');
    expect(session.workspace).toBe('本机工作区');
    expect(readSession()).toMatchObject({
      mode: 'local',
      name: '本机用户',
      role: '本机用户',
    });
  });

  it('登录团队服务后建立团队会话', () => {
    enterTeamSession(
      'http://127.0.0.1:8080',
      { account: 'zhangsan', displayName: '张三' },
      { id: 'team-1', name: '支付中台', role: 'member' },
    );

    expect(readSession()).toMatchObject({
      mode: 'team',
      workspace: '支付中台',
      name: '张三',
      role: 'member',
      team: {
        id: 'team-1',
        name: '支付中台',
        role: 'member',
        serverUrl: 'http://127.0.0.1:8080',
        member: '张三',
      },
    });
  });

  it('旧会话自动迁移为本机模式', () => {
    kvSet(
      'aw-session',
      JSON.stringify({
        account: 'dev@internal',
        name: 'dev',
        role: '本机用户',
        workspace: '本机工作区',
        signedAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    expect(readSession()).toMatchObject({
      mode: 'local',
      workspace: '本机工作区',
    });
  });

  it('缺少服务端信息的旧团队会话需要重新登录', () => {
    kvSet(
      'aw-session',
      JSON.stringify({
        mode: 'team',
        account: '张三',
        name: '张三',
        role: '团队成员',
        workspace: '支付中台',
        team: { name: '支付中台', member: '张三' },
        signedAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    expect(readSession()).toBeNull();
  });
});
