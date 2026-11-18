import { deleteSecretNow, persistSecretNow, secretGet } from './secretStore';

export interface RememberedLogin {
  account: string;
  password: string;
  rememberAccount: boolean;
  rememberPassword: boolean;
}

const KEY_PREFIX = 'login-creds:';

function normalizeServerUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function credentialKey(serverUrl: string): string {
  return `${KEY_PREFIX}${encodeURIComponent(normalizeServerUrl(serverUrl))}`;
}

export function readRememberedLogin(serverUrl: string): RememberedLogin | null {
  if (!normalizeServerUrl(serverUrl)) return null;
  try {
    const raw = secretGet(credentialKey(serverUrl));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedLogin>;
    if (parsed?.rememberAccount !== true) return null;
    return {
      account: typeof parsed.account === 'string' ? parsed.account : '',
      password: typeof parsed.password === 'string' ? parsed.password : '',
      rememberAccount: true,
      rememberPassword: parsed.rememberPassword === true,
    };
  } catch {
    return null;
  }
}

export async function saveRememberedLogin(
  serverUrl: string,
  value: RememberedLogin,
): Promise<boolean> {
  const key = credentialKey(serverUrl);
  if (!normalizeServerUrl(serverUrl) || !value.rememberAccount) {
    await deleteSecretNow(key);
    return true;
  }

  const payload = JSON.stringify({
    account: value.account,
    password: value.rememberPassword ? value.password : '',
    rememberAccount: true,
    rememberPassword: value.rememberPassword,
  });
  return persistSecretNow(key, payload);
}

export async function clearRememberedLogin(serverUrl: string): Promise<void> {
  if (!normalizeServerUrl(serverUrl)) return;
  await deleteSecretNow(credentialKey(serverUrl));
}
