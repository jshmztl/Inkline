import { beforeEach, describe, expect, it } from 'vitest';
import { kvSet } from './kv';
import { enterLocal, enterTeam, readSession, saveTeamProfile, signOut } from './session';

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

  it('团队工作区必须填写团队与成员', () => {
    expect(enterTeam('', '张三')).toEqual({ error: '请输入团队名称' });
    expect(enterTeam('支付中台', '')).toEqual({ error: '请输入成员名称' });
  });

  it('进入团队工作区并可修改团队设置', () => {
    const created = enterTeam('支付中台', '张三');
    if ('error' in created) throw new Error(created.error);

    expect(readSession()).toMatchObject({
      mode: 'team',
      workspace: '支付中台',
      name: '张三',
      role: '团队成员',
      team: { name: '支付中台', member: '张三' },
    });

    const updated = saveTeamProfile('订单中台', '李四');
    if ('error' in updated) throw new Error(updated.error);

    expect(updated.workspace).toBe('订单中台');
    expect(readSession()).toMatchObject({
      name: '李四',
      workspace: '订单中台',
      team: { name: '订单中台', member: '李四' },
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
});
