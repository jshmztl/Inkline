import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRememberedLogin,
  readRememberedLogin,
  saveRememberedLogin,
} from './rememberedLogin';
import { resetSecretStoreForTests } from './secretStore';

describe('rememberedLogin', () => {
  beforeEach(() => {
    resetSecretStoreForTests();
  });

  it('保存并读取账号与口令', async () => {
    const saved = await saveRememberedLogin('http://team.local:8080/', {
      account: 'alice',
      password: 'secret-123',
      rememberAccount: true,
      rememberPassword: true,
    });

    expect(saved).toBe(true);
    expect(readRememberedLogin('http://team.local:8080')).toEqual({
      account: 'alice',
      password: 'secret-123',
      rememberAccount: true,
      rememberPassword: true,
    });
  });

  it('未勾选记住口令时只保存账号', async () => {
    await saveRememberedLogin('http://team.local:8080', {
      account: 'alice',
      password: 'secret-123',
      rememberAccount: true,
      rememberPassword: false,
    });

    expect(readRememberedLogin('http://team.local:8080')).toMatchObject({
      account: 'alice',
      password: '',
      rememberPassword: false,
    });
  });

  it('不同服务器凭据相互隔离', async () => {
    await saveRememberedLogin('http://team-a.local', {
      account: 'alice',
      password: 'a-secret',
      rememberAccount: true,
      rememberPassword: true,
    });
    await saveRememberedLogin('http://team-b.local', {
      account: 'bob',
      password: 'b-secret',
      rememberAccount: true,
      rememberPassword: true,
    });

    expect(readRememberedLogin('http://team-a.local')?.account).toBe('alice');
    expect(readRememberedLogin('http://team-b.local')?.account).toBe('bob');
  });

  it('未勾选记住账号时删除已有记录', async () => {
    await saveRememberedLogin('http://team.local', {
      account: 'alice',
      password: 'secret-123',
      rememberAccount: true,
      rememberPassword: true,
    });
    await saveRememberedLogin('http://team.local', {
      account: 'alice',
      password: 'secret-123',
      rememberAccount: false,
      rememberPassword: false,
    });

    expect(readRememberedLogin('http://team.local')).toBeNull();
  });

  it('可以清除已保存凭据', async () => {
    await saveRememberedLogin('http://team.local', {
      account: 'alice',
      password: 'secret-123',
      rememberAccount: true,
      rememberPassword: true,
    });

    await clearRememberedLogin('http://team.local');
    expect(readRememberedLogin('http://team.local')).toBeNull();
  });
});
