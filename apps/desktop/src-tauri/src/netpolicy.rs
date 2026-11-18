use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use if_addrs::IfAddr;
use serde::Serialize;

const INTRANET_SUFFIXES: [&str; 7] = [
    ".internal", ".local", ".lan", ".corp", ".intra", ".home", ".svc",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkMode {
    Offline,
    Intranet,
    Public,
}

impl NetworkMode {
    pub fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some("A") | Some("a") => Self::Offline,
            Some("C") | Some("c") => Self::Public,
            _ => Self::Intranet,
        }
    }
}

#[derive(Debug, Clone)]
pub struct NetworkPolicy {
    pub mode: NetworkMode,
    pub intranet_cidrs: Vec<String>,
}

impl Default for NetworkPolicy {
    fn default() -> Self {
        Self {
            mode: NetworkMode::Intranet,
            intranet_cidrs: Vec::new(),
        }
    }
}

impl NetworkPolicy {
    pub fn from_parts(mode: Option<&str>, intranet_cidrs: &[String]) -> Self {
        Self {
            mode: NetworkMode::parse(mode),
            intranet_cidrs: intranet_cidrs
                .iter()
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect(),
        }
    }

    /// 仅按主机名 / 字面 IP 判断，不做 DNS 解析，供重定向逐跳校验使用。
    pub fn ensure_allowed(&self, url: &str) -> Result<(), String> {
        let parsed =
            reqwest::Url::parse(url).map_err(|error| format!("无法解析目标地址：{error}"))?;
        let raw_host = parsed
            .host_str()
            .ok_or_else(|| "目标地址缺少主机名".to_string())?;
        let host = normalize_host(raw_host);

        if self.mode == NetworkMode::Public {
            return Ok(());
        }
        if is_loopback_host(&host) {
            return Ok(());
        }
        if self.mode == NetworkMode::Offline {
            return Err(format!(
                "A 离线模式只允许本机地址（localhost / 127.0.0.1），已阻止 {host}"
            ));
        }
        if self.matches_cidr(&host) || is_intranet_host(&host) {
            return Ok(());
        }

        Err(format!(
            "B 内网模式已阻止 {host}：跨网段内网地址请到「网络设置」添加内网网段，公网访问请切换到 C 外网"
        ))
    }

    /// B 模式下若主机名本身不像内网地址，再做一次 DNS 解析并检查解析结果。
    pub async fn ensure_allowed_resolved(&self, url: &str) -> Result<(), String> {
        let reason = match self.ensure_allowed(url) {
            Ok(()) => return Ok(()),
            Err(reason) => reason,
        };
        if self.mode != NetworkMode::Intranet {
            return Err(reason);
        }

        let Ok(parsed) = reqwest::Url::parse(url) else {
            return Err(reason);
        };
        let Some(raw_host) = parsed.host_str() else {
            return Err(reason);
        };
        let host = normalize_host(raw_host);
        if host.parse::<IpAddr>().is_ok() {
            return Err(reason);
        }

        let port = parsed.port_or_known_default().unwrap_or(80);
        let Ok(addresses) = tokio::net::lookup_host((host.as_str(), port)).await else {
            return Err(reason);
        };

        let local = local_cidrs();
        for address in addresses {
            let ip = address.ip();
            if is_intranet_ip(ip) || self.matches_cidr(&ip.to_string()) || in_local_cidrs(ip, &local)
            {
                return Ok(());
            }
        }

        Err(reason)
    }

    /// A 离线模式下禁止对外做 DNS 解析，避免通过解析请求泄露目标。
    pub fn ensure_probe_allowed(&self, host: &str) -> Result<(), String> {
        if self.mode != NetworkMode::Offline {
            return Ok(());
        }
        let host = normalize_host(host);
        if is_loopback_host(&host) {
            Ok(())
        } else {
            Err(format!("A 离线模式禁止解析非本机地址：{host}"))
        }
    }

    fn matches_cidr(&self, host: &str) -> bool {
        let Ok(ip) = host.parse::<IpAddr>() else {
            return false;
        };
        self.intranet_cidrs
            .iter()
            .any(|cidr| cidr_contains(cidr, ip))
    }
}

/// 对所有跟随的重定向逐跳执行同一套策略；请求自身的初始地址由调用方先行校验。
pub fn redirect_policy(policy: NetworkPolicy) -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.error("重定向次数过多");
        }
        match policy.ensure_allowed(attempt.url().as_str()) {
            Ok(()) => attempt.follow(),
            Err(reason) => attempt.error(reason),
        }
    })
}

pub fn local_cidrs() -> Vec<String> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };

    let mut cidrs = Vec::new();
    for interface in interfaces {
        match interface.addr {
            IfAddr::V4(address) => {
                cidrs.push(format!("{}/{}", address.ip, prefix_v4(address.netmask)));
            }
            IfAddr::V6(address) => {
                let prefix = prefix_v6(address.netmask);
                if prefix > 0 {
                    cidrs.push(format!("{}/{}", address.ip, prefix));
                }
            }
        }
    }
    cidrs
}

fn prefix_v4(mask: Ipv4Addr) -> u32 {
    u32::from(mask).count_ones()
}

fn prefix_v6(mask: Ipv6Addr) -> u32 {
    u128::from(mask).leading_ones()
}

fn normalize_host(host: &str) -> String {
    host.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

fn is_loopback_host(host: &str) -> bool {
    host == "localhost"
        || host.ends_with(".localhost")
        || host == "0.0.0.0"
        || host.starts_with("127.")
        || host
            .parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

fn is_intranet_host(host: &str) -> bool {
    if is_loopback_host(host) {
        return true;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return is_intranet_ip(ip);
    }
    if !host.contains('.') {
        return true;
    }
    INTRANET_SUFFIXES
        .iter()
        .any(|suffix| host.ends_with(suffix))
}

fn is_intranet_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified()
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || is_ipv6_unique_local(ip)
                || ip.is_unicast_link_local()
        }
    }
}

fn is_ipv6_unique_local(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xfe00) == 0xfc00
}

fn in_local_cidrs(ip: IpAddr, cidrs: &[String]) -> bool {
    cidrs.iter().any(|cidr| cidr_contains(cidr, ip))
}

fn cidr_contains(cidr: &str, ip: IpAddr) -> bool {
    let Some((base, prefix)) = cidr.split_once('/') else {
        return false;
    };
    let Ok(base) = base.trim().parse::<IpAddr>() else {
        return false;
    };
    let Ok(prefix) = prefix.trim().parse::<u8>() else {
        return false;
    };

    match (base, ip) {
        (IpAddr::V4(base), IpAddr::V4(ip)) => {
            if prefix > 32 {
                return false;
            }
            let mask = if prefix == 0 {
                0
            } else {
                u32::MAX << (32 - prefix)
            };
            (u32::from(ip) & mask) == (u32::from(base) & mask)
        }
        (IpAddr::V6(base), IpAddr::V6(ip)) => {
            if prefix > 128 {
                return false;
            }
            let mask = if prefix == 0 {
                0
            } else {
                u128::MAX << (128 - prefix)
            };
            (u128::from(ip) & mask) == (u128::from(base) & mask)
        }
        _ => false,
    }
}


#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkAccessDecision {
    pub allowed: bool,
    pub reason: String,
}

#[tauri::command]
pub async fn check_network_access(
    url: String,
    mode: Option<String>,
    intranet_cidrs: Option<Vec<String>>,
    resolve: Option<bool>,
) -> Result<NetworkAccessDecision, String> {
    let cidrs = intranet_cidrs.unwrap_or_default();
    let policy = NetworkPolicy::from_parts(mode.as_deref(), &cidrs);
    let result = if resolve.unwrap_or(true) {
        policy.ensure_allowed_resolved(&url).await
    } else {
        policy.ensure_allowed(&url)
    };
    match result {
        Ok(()) => Ok(NetworkAccessDecision {
            allowed: true,
            reason: "允许访问".to_string(),
        }),
        Err(reason) => Ok(NetworkAccessDecision {
            allowed: false,
            reason,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(mode: &str, cidrs: &[&str]) -> NetworkPolicy {
        let cidrs: Vec<String> = cidrs.iter().map(|item| item.to_string()).collect();
        NetworkPolicy::from_parts(Some(mode), &cidrs)
    }

    #[test]
    fn offline_only_allows_loopback() {
        let policy = policy("A", &[]);
        assert!(policy.ensure_allowed("http://127.0.0.1:8080/health").is_ok());
        assert!(policy.ensure_allowed("http://localhost/health").is_ok());
        assert!(policy.ensure_allowed("http://[::1]:8080/health").is_ok());
        assert!(policy.ensure_allowed("http://192.168.1.10/api").is_err());
        assert!(policy.ensure_allowed("https://example.com").is_err());
    }

    #[test]
    fn intranet_allows_private_and_intranet_names() {
        let policy = policy("B", &[]);
        assert!(policy.ensure_allowed("http://10.1.2.3/api").is_ok());
        assert!(policy.ensure_allowed("http://172.20.0.1/api").is_ok());
        assert!(policy.ensure_allowed("http://192.168.1.10/api").is_ok());
        assert!(policy.ensure_allowed("http://gateway.internal/api").is_ok());
        assert!(policy.ensure_allowed("http://api-gateway/api").is_ok());
        assert!(policy.ensure_allowed("http://[fd00::1]/api").is_ok());
    }

    #[test]
    fn intranet_blocks_public_and_boundary_addresses() {
        let policy = policy("B", &[]);
        assert!(policy.ensure_allowed("https://example.com").is_err());
        assert!(policy.ensure_allowed("http://8.8.8.8").is_err());
        assert!(policy.ensure_allowed("http://172.32.0.1").is_err());
        assert!(policy.ensure_allowed("http://localhost.evil.com").is_err());
    }

    #[test]
    fn whitelist_allows_cross_subnet_intranet() {
        let policy = policy("B", &["32.26.0.0/16"]);
        assert!(policy.ensure_allowed("http://32.26.139.82:8080/admin/").is_ok());
        assert!(policy.ensure_allowed("http://32.27.139.82:8080/admin/").is_err());
    }

    #[test]
    fn whitelist_supports_ipv6() {
        let policy = policy("B", &["fd00::/8"]);
        assert!(policy.ensure_allowed("http://[fd12:3456::1]/api").is_ok());
        assert!(policy.ensure_allowed("http://[2001:db8::1]/api").is_err());
    }

    #[test]
    fn public_mode_allows_everything() {
        let policy = policy("C", &[]);
        assert!(policy.ensure_allowed("https://example.com").is_ok());
        assert!(policy.ensure_allowed("http://8.8.8.8").is_ok());
    }

    #[test]
    fn malformed_cidr_is_ignored() {
        let policy = policy("B", &["not-a-cidr", "10.0.0.0/33"]);
        assert!(policy.ensure_allowed("http://10.0.0.1").is_ok());
        assert!(policy.ensure_allowed("http://11.0.0.1").is_err());
    }

    #[test]
    fn probe_is_restricted_in_offline_mode() {
        let policy = policy("A", &[]);
        assert!(policy.ensure_probe_allowed("localhost").is_ok());
        assert!(policy.ensure_probe_allowed("127.0.0.1").is_ok());
        assert!(policy.ensure_probe_allowed("example.com").is_err());
    }

    #[tokio::test]
    async fn check_network_access_command_matches_policy() {
        let allowed = check_network_access(
            "http://127.0.0.1:8080/health".to_string(),
            Some("A".to_string()),
            None,
            Some(false),
        )
        .await
        .expect("command should succeed");
        assert!(allowed.allowed);

        let blocked = check_network_access(
            "https://example.com".to_string(),
            Some("B".to_string()),
            None,
            Some(false),
        )
        .await
        .expect("command should succeed");
        assert!(!blocked.allowed);
        assert!(blocked.reason.contains("B 内网模式已阻止"));
    }
}
