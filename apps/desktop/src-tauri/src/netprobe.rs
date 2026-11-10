use std::net::{Ipv4Addr, Ipv6Addr, ToSocketAddrs};

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkProbe {
    pub host_ips: Vec<String>,
    pub local_cidrs: Vec<String>,
}

fn prefix_v4(mask: Ipv4Addr) -> u32 {
    u32::from(mask).count_ones()
}

fn prefix_v6(mask: Ipv6Addr) -> u32 {
    u128::from(mask).leading_ones()
}

fn local_cidrs() -> Vec<String> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };

    let mut cidrs = Vec::new();
    for interface in interfaces {
        match interface.addr {
            if_addrs::IfAddr::V4(address) => {
                cidrs.push(format!("{}/{}", address.ip, prefix_v4(address.netmask)));
            }
            if_addrs::IfAddr::V6(address) => {
                let prefix = prefix_v6(address.netmask);
                if prefix > 0 {
                    cidrs.push(format!("{}/{}", address.ip, prefix));
                }
            }
        }
    }
    cidrs
}

#[tauri::command]
pub async fn probe_network(host: String, port: u16) -> Result<NetworkProbe, String> {
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
        let probe = probe_network("localhost".to_string(), 80)
            .await
            .expect("probe should succeed");
        assert!(!probe.host_ips.is_empty());
        assert!(probe.local_cidrs.iter().any(|cidr| cidr.contains('/')));
    }
}
