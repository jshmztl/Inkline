import { useEffect, useState } from 'react';
import { App, Button, Checkbox, Input, Modal } from 'antd';
import { clearCookies } from '../lib/api';
import {
  readNetworkOptions,
  writeNetworkOptions,
  type NetworkOptions,
} from '../lib/network';

interface NetworkSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function NetworkSettingsModal({ open, onClose }: NetworkSettingsModalProps) {
  const { message } = App.useApp();
  const [options, setOptions] = useState<NetworkOptions>(readNetworkOptions);

  useEffect(() => {
    if (open) setOptions(readNetworkOptions());
  }, [open]);

  return (
    <Modal
      open={open}
      title="网络设置"
      width={520}
      onCancel={onClose}
      footer={[
        <Button key="cancel" size="small" onClick={onClose}>
          取消
        </Button>,
        <Button
          key="save"
          type="primary"
          size="small"
          onClick={() => {
            writeNetworkOptions(options);
            onClose();
          }}
        >
          保存
        </Button>,
      ]}
    >
      <div className="network-form">
        <label>
          <span>HTTP / HTTPS 代理</span>
          <Input
            value={options.proxy}
            placeholder="http://127.0.0.1:7890"
            onChange={(event) =>
              setOptions((current) => ({ ...current, proxy: event.target.value }))
            }
          />
        </label>
        <label>
          <span>内网网段白名单（每行一个 CIDR）</span>
          <Input.TextArea
            value={options.intranetCidrs}
            rows={3}
            placeholder={'192.168.0.0/16\n10.0.0.0/8'}
            onChange={(event) =>
              setOptions((current) => ({
                ...current,
                intranetCidrs: event.target.value,
              }))
            }
          />
        </label>
        <p className="network-tip">
          仅 B 内网模式生效。用于放行跨网段的政府/企业内网地址，例如本机
          192.168.1.x、服务器 192.168.2.x 时可填写 192.168.0.0/16；公网地址仍会被拦截。
        </p>
        <label>
          <span>客户端证书（PEM 文件路径）</span>
          <Input
            value={options.clientCertPath}
            placeholder="C:\\certs\\client.pem"
            onChange={(event) =>
              setOptions((current) => ({
                ...current,
                clientCertPath: event.target.value,
              }))
            }
          />
        </label>
        <p className="network-tip">
          PEM 文件需同时包含客户端证书与私钥。配置仅在桌面应用中生效，留空表示不使用。
        </p>
        <label>
          <span>HTTPS 证书校验</span>
          <Checkbox
            checked={options.acceptInvalidCerts}
            onChange={(event) =>
              setOptions((current) => ({
                ...current,
                acceptInvalidCerts: event.target.checked,
              }))
            }
          >
            忽略证书校验（内网自签证书）
          </Checkbox>
        </label>
        <p className="network-tip">
          仅建议在内网自签证书或私有 CA 环境下开启。开启后不再校验服务端证书，存在中间人风险。
        </p>
        <label>
          <span>重定向</span>
          <Checkbox
            checked={options.followRedirects}
            onChange={(event) =>
              setOptions((current) => ({
                ...current,
                followRedirects: event.target.checked,
              }))
            }
          >
            自动跟随 301 / 302 重定向
          </Checkbox>
        </label>
        <p className="network-tip">
          关闭后请求会停在重定向响应，可在响应头中查看 Location 与状态码。
        </p>
        <div>
          <Button
            size="small"
            onClick={() => {
              void clearCookies()
                .then(() => message.success('已清除 Cookie'))
                .catch(() => message.warning('仅桌面应用支持清除 Cookie'));
            }}
          >
            清除 Cookie
          </Button>
        </div>
      </div>
    </Modal>
  );
}
