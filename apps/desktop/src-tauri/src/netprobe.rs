use std::net::ToSocketAddrs;

use serde::Serialize;

use crate::netpolicy::{local_cidrs, NetworkPolicy};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkProbe {
    pub host_ips: Vec<String>,
    pub local_cidrs: Vec<String>,
}

#[tauri::command]
pub async fn probe_network(
    host: String,
    port: u16,
    mode: Option<String>,
) -> Result<NetworkProbe, String> {
    let policy = NetworkPolicy::from_parts(mode.as_deref(), &[]);
    policy.ensure_probe_allowed(&host)?;

    let host_ips = tokio::task::spawn_blocking(move || {
        (host.as_str(), port)
            .to_socket_addrs()
            .map(|addresses| {
                let mut ips: Vec<String> =
                    addresses.map(|address| address.ip().to_string()).collect();
                ips.sort();
                ips.dedup();
                ips
            })
            .map_err(|error| format!("解析主机失败：{error}"))
    })
    .await
    .map_err(|error| format!("解析任务失败：{error}"))??;

    Ok(NetworkProbe {
        host_ips,
        local_cidrs: local_cidrs(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn probe_resolves_host_and_collects_local_cidrs() {
        let probe = probe_network("localhost".to_string(), 80, None)
            .await
            .expect("probe should succeed");
        assert!(!probe.host_ips.is_empty());
        assert!(probe.local_cidrs.iter().any(|cidr| cidr.contains('/')));
    }
}
