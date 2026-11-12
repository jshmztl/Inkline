import { Input, Segmented } from 'antd';

export type AuthType = 'none' | 'bearer' | 'basic' | 'apikey';

interface RequestAuthPanelProps {
  authType: AuthType;
  onAuthTypeChange: (type: AuthType) => void;
  authToken: string;
  onAuthTokenChange: (value: string) => void;
  authUser: string;
  onAuthUserChange: (value: string) => void;
  authPass: string;
  onAuthPassChange: (value: string) => void;
  apiKeyName: string;
  onApiKeyNameChange: (value: string) => void;
  apiKeyValue: string;
  onApiKeyValueChange: (value: string) => void;
}

/** 鉴权表单：无 / Bearer / Basic / API Key。 */
export function RequestAuthPanel({
  authType,
  onAuthTypeChange,
  authToken,
  onAuthTokenChange,
  authUser,
  onAuthUserChange,
  authPass,
  onAuthPassChange,
  apiKeyName,
  onApiKeyNameChange,
  apiKeyValue,
  onApiKeyValueChange,
}: RequestAuthPanelProps) {
  return (
    <div className="auth-panel">
      <div className="auth-card">
        <Segmented
          size="small"
          value={authType}
          onChange={(value) => onAuthTypeChange(value as AuthType)}
          options={[
            { label: '无', value: 'none' },
            { label: 'Bearer', value: 'bearer' },
            { label: 'Basic', value: 'basic' },
            { label: 'API Key', value: 'apikey' },
          ]}
        />

        {authType === 'bearer' && (
          <label className="auth-field">
            <span>Token</span>
            <Input.Password
              value={authToken}
              onChange={(event) => onAuthTokenChange(event.target.value)}
              placeholder="{{token}}"
              aria-label="Bearer Token"
            />
          </label>
        )}

        {authType === 'basic' && (
          <>
            <label className="auth-field">
              <span>用户名</span>
              <Input
                value={authUser}
                onChange={(event) => onAuthUserChange(event.target.value)}
                aria-label="Basic 用户名"
              />
            </label>
            <label className="auth-field">
              <span>口令</span>
              <Input.Password
                value={authPass}
                onChange={(event) => onAuthPassChange(event.target.value)}
                aria-label="Basic 口令"
              />
            </label>
          </>
        )}

        {authType === 'apikey' && (
          <>
            <label className="auth-field">
              <span>Header 名</span>
              <Input
                value={apiKeyName}
                onChange={(event) => onApiKeyNameChange(event.target.value)}
                aria-label="API Key 名称"
              />
            </label>
            <label className="auth-field">
              <span>值</span>
              <Input.Password
                value={apiKeyValue}
                onChange={(event) => onApiKeyValueChange(event.target.value)}
                aria-label="API Key 值"
              />
            </label>
          </>
        )}

        <p>
          支持 <code>{'{{变量}}'}</code> 引用环境变量。鉴权信息在发送时写入请求头，不额外落盘。
        </p>
      </div>
    </div>
  );
}
