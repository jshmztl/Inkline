use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::StreamExt;
use reqwest::cookie::Jar;
use reqwest::multipart::{Form, Part};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::oneshot;

use crate::model::HeaderPair;
use crate::netpolicy::{redirect_policy, NetworkPolicy};

#[derive(Default)]
pub struct CancelState(pub Mutex<HashMap<String, oneshot::Sender<()>>>);

#[derive(Default)]
pub struct CookieState(pub Mutex<Arc<Jar>>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultipartField {
    pub name: String,
    pub value: Option<String>,
    pub file_name: Option<String>,
    pub file_base64: Option<String>,
    pub content_type: Option<String>,
}

#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NetworkOptions {
    pub proxy: Option<String>,
    pub client_cert_path: Option<String>,
    pub accept_invalid_certs: Option<bool>,
    pub follow_redirects: Option<bool>,
    pub mode: Option<String>,
    #[serde(default)]
    pub intranet_cidrs: Vec<String>,
}

impl NetworkOptions {
    pub fn policy(&self) -> NetworkPolicy {
        NetworkPolicy::from_parts(self.mode.as_deref(), &self.intranet_cidrs)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequestPayload {
    pub id: Option<String>,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<HeaderPair>,
    pub body: Option<String>,
    pub timeout_ms: Option<u64>,
    pub multipart: Option<Vec<MultipartField>>,
    pub network: Option<NetworkOptions>,
    /// 默认启用 Cookie 容器；团队同步等内部请求应关闭，避免与调试会话互相污染。
    #[serde(default)]
    pub use_cookies: Option<bool>,
    /// 跳过并行的 DNS/TCP/TLS 探测，内部请求不需要分阶段耗时。
    #[serde(default)]
    pub skip_probe: Option<bool>,
    /// 响应体读取上限，默认 10 MiB。超出后截断并标记 truncated。
    #[serde(default)]
    pub max_body_bytes: Option<usize>,
}

/// 默认响应体上限，避免超大响应把进程内存打满。
pub const DEFAULT_MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<HeaderPair>,
    pub body: String,
    pub duration_ms: u64,
    pub ttfb_ms: u64,
    pub download_ms: u64,
    pub dns_ms: Option<u64>,
    pub tcp_ms: Option<u64>,
    pub tls_ms: Option<u64>,
    pub size_bytes: usize,
    pub truncated: bool,
}

#[tauri::command]
pub async fn send_http_request(
    payload: SendRequestPayload,
    cancel: State<'_, CancelState>,
    cookie: State<'_, CookieState>,
) -> Result<SendResponse, String> {
    let cookie_provider = cookie
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .clone();

    let request_id = payload.id.clone();
    if request_id.is_none() {
        return send_with_cookie(payload, cookie_provider, None).await;
    }

    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let id = request_id.unwrap_or_default();
    cancel
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .insert(id.clone(), cancel_tx);

    let result = send_with_cookie(payload, cookie_provider, Some(cancel_rx)).await;

    if let Ok(mut pending) = cancel.0.lock() {
        pending.remove(&id);
    }

    result
}

/// 实际发送请求的核心逻辑，便于在测试中注入 Cookie 容器而不依赖 Tauri 状态。
pub(crate) async fn send_with_cookie(
    payload: SendRequestPayload,
    cookie_provider: Arc<Jar>,
    cancel_rx: Option<oneshot::Receiver<()>>,
) -> Result<SendResponse, String> {
    let use_cookies = payload.use_cookies.unwrap_or(true);
    let cookie_provider = if use_cookies {
        cookie_provider
    } else {
        Arc::new(Jar::default())
    };

    let url = reqwest::Url::parse(&payload.url).map_err(|error| format!("URL 无效：{error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("仅支持 http/https 请求".to_string());
    }

    let policy = payload
        .network
        .as_ref()
        .map(NetworkOptions::policy)
        .unwrap_or_default();
    policy.ensure_allowed_resolved(&payload.url).await?;

    let method = Method::from_bytes(payload.method.to_uppercase().as_bytes())
        .map_err(|error| format!("请求方法无效：{error}"))?;

    let mut client = reqwest::Client::builder()
        .timeout(Duration::from_millis(payload.timeout_ms.unwrap_or(30_000)))
        .cookie_provider(cookie_provider);

    if let Some(network) = &payload.network {
        if network.accept_invalid_certs.unwrap_or(false) {
            client = client.danger_accept_invalid_certs(true);
        }
        if let Some(proxy) = network
            .proxy
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            client = client
                .proxy(reqwest::Proxy::all(proxy).map_err(|error| format!("代理地址无效：{error}"))?);
        }
        if let Some(path) = network
            .client_cert_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let pem = tokio::fs::read(path)
                .await
                .map_err(|error| format!("读取客户端证书失败：{error}"))?;
            let identity = reqwest::Identity::from_pem(&pem)
                .map_err(|error| format!("客户端证书格式无效：{error}"))?;
            client = client.identity(identity);
        }
    }

    let follow_redirects = payload
        .network
        .as_ref()
        .and_then(|network| network.follow_redirects)
        .unwrap_or(true);
    client = client.redirect(if follow_redirects {
        redirect_policy(policy)
    } else {
        reqwest::redirect::Policy::none()
    });

    let client = client
        .build()
        .map_err(|error| format!("创建 HTTP 客户端失败：{error}"))?;

    let probe_url = url.clone();
    let skip_probe = payload.skip_probe.unwrap_or(false);
    let probe_enabled = !skip_probe
        && payload
            .network
            .as_ref()
            .map(|network| {
                let has_proxy = network
                    .proxy
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|value| !value.is_empty());
                let has_client_cert = network
                    .client_cert_path
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|value| !value.is_empty());
                !has_proxy && !has_client_cert
            })
            .unwrap_or(true);
    let max_body_bytes = payload
        .max_body_bytes
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_RESPONSE_BYTES);
    let accept_invalid_certs = payload
        .network
        .as_ref()
        .and_then(|network| network.accept_invalid_certs)
        .unwrap_or(false);

    let mut request = client.request(method, url);
    for header in &payload.headers {
        if header.name.trim().is_empty() {
            continue;
        }
        if payload.multipart.is_some() && header.name.eq_ignore_ascii_case("content-type") {
            continue;
        }
        request = request.header(header.name.trim(), header.value.as_str());
    }

    if let Some(fields) = &payload.multipart {
        let mut form = Form::new();
        for field in fields {
            if field.name.trim().is_empty() {
                continue;
            }
            if let Some(encoded) = &field.file_base64 {
                let bytes = STANDARD
                    .decode(encoded)
                    .map_err(|error| format!("文件内容解码失败：{error}"))?;
                let mut part = Part::bytes(bytes);
                if let Some(name) = &field.file_name {
                    part = part.file_name(name.clone());
                }
                if let Some(content_type) = &field.content_type {
                    if !content_type.trim().is_empty() {
                        part = part
                            .mime_str(content_type)
                            .map_err(|error| format!("文件类型无效：{error}"))?;
                    }
                }
                form = form.part(field.name.clone(), part);
            } else if let Some(value) = &field.value {
                form = form.text(field.name.clone(), value.clone());
            }
        }
        request = request.multipart(form);
    } else if let Some(body) = payload.body {
        if !body.is_empty() {
            request = request.body(body);
        }
    }

    let started = Instant::now();

    let work = async {
        let response = request
            .send()
            .await
            .map_err(describe_request_error)?;
        let ttfb_ms = started.elapsed().as_millis() as u64;

        let status = response.status();
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| HeaderPair {
                name: name.to_string(),
                value: value.to_str().unwrap_or("").to_string(),
            })
            .collect();
        let declared_size = response
            .content_length()
            .map(|value| value as usize);
        let (body, size_bytes, truncated) =
            read_body_limited(response, max_body_bytes, declared_size).await?;
        let duration_ms = started.elapsed().as_millis() as u64;

        Ok::<SendResponse, String>(SendResponse {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").to_string(),
            headers,
            body,
            duration_ms,
            ttfb_ms,
            download_ms: duration_ms.saturating_sub(ttfb_ms),
            dns_ms: None,
            tcp_ms: None,
            tls_ms: None,
            size_bytes,
            truncated,
        })
    };

    let probe = async move {
        if probe_enabled {
            crate::timing::probe(&probe_url, accept_invalid_certs).await
        } else {
            None
        }
    };

    let combined = async {
        let (result, timings) = tokio::join!(work, probe);
        result.map(|mut response| {
            if let Some(timings) = timings {
                response.dns_ms = Some(timings.dns_ms);
                response.tcp_ms = Some(timings.tcp_ms);
                response.tls_ms = timings.tls_ms;
            }
            response
        })
    };

    if let Some(cancel_rx) = cancel_rx {
        tokio::select! {
            result = combined => result,
            _ = cancel_rx => Err("请求已取消".to_string()),
        }
    } else {
        combined.await
    }
}

#[tauri::command]
pub fn cancel_http_request(cancel: State<'_, CancelState>, id: String) -> Result<(), String> {
    if let Ok(mut pending) = cancel.0.lock() {
        if let Some(sender) = pending.remove(&id) {
            let _ = sender.send(());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn clear_cookies(cookie: State<'_, CookieState>) -> Result<(), String> {
    let mut jar = cookie.0.lock().map_err(|error| error.to_string())?;
    *jar = Arc::new(Jar::default());
    Ok(())
}


async fn read_body_limited(
    response: reqwest::Response,
    max_body_bytes: usize,
    declared_size: Option<usize>,
) -> Result<(String, usize, bool), String> {
    let mut received = Vec::new();
    let mut truncated = false;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取响应失败：{error}"))?;
        if received.len() >= max_body_bytes {
            truncated = true;
            break;
        }
        let remaining = max_body_bytes - received.len();
        if chunk.len() > remaining {
            received.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }
        received.extend_from_slice(&chunk);
    }
    let size_bytes = if truncated {
        declared_size
            .filter(|value| *value >= received.len())
            .unwrap_or(received.len())
    } else {
        declared_size.unwrap_or(received.len()).max(received.len())
    };
    let body = String::from_utf8_lossy(&received).into_owned();
    Ok((body, size_bytes, truncated))
}

/// reqwest 的重定向错误只展示外层描述，这里把 source 链里的原因拼进用户可见信息。
fn describe_request_error(error: reqwest::Error) -> String {
    let mut message = format!("请求失败：{error}");
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        let text = cause.to_string();
        if !text.is_empty() && !message.contains(&text) {
            message.push_str(&format!("：{text}"));
        }
        source = cause.source();
    }
    message
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use super::*;

    /// 启动一次性本地 HTTP 服务，返回访问地址与服务线程。
    /// 探测连接只建连不发数据，这里读到 0 字节后直接关闭。
    fn spawn_http_server(body: &'static str) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind local server");
        let address = listener.local_addr().expect("local addr");
        listener
            .set_nonblocking(true)
            .expect("set nonblocking listener");

        let handle = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                        let mut buffer = [0_u8; 2048];
                        let read = stream.read(&mut buffer).unwrap_or(0);
                        if read == 0 {
                            continue;
                        }
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        );
                        let _ = stream.write_all(response.as_bytes());
                        let _ = stream.flush();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });

        (format!("http://{address}/health"), handle)
    }

    fn spawn_redirect_server(location: &'static str) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind redirect server");
        let address = listener.local_addr().expect("local addr");
        listener
            .set_nonblocking(true)
            .expect("set nonblocking listener");

        let handle = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                        let mut buffer = [0_u8; 2048];
                        let read = stream.read(&mut buffer).unwrap_or(0);
                        if read == 0 {
                            continue;
                        }
                        let response = format!(
                            "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        );
                        let _ = stream.write_all(response.as_bytes());
                        let _ = stream.flush();
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });

        (format!("http://{address}/start"), handle)
    }

    fn get_payload(url: &str) -> SendRequestPayload {
        SendRequestPayload {
            id: None,
            method: "GET".to_string(),
            url: url.to_string(),
            headers: vec![HeaderPair {
                name: "X-Test".to_string(),
                value: "inkline".to_string(),
            }],
            body: None,
            timeout_ms: Some(5_000),
            multipart: None,
            network: None,
            use_cookies: None,
            skip_probe: None,
            max_body_bytes: None,
        }
    }

    #[tokio::test]
    async fn sends_request_against_real_socket_and_reports_timings() {
        let (url, handle) = spawn_http_server("ok");

        let response = send_with_cookie(get_payload(&url), Arc::new(Jar::default()), None)
            .await
            .expect("request should succeed");

        assert_eq!(response.status, 200);
        assert_eq!(response.status_text, "OK");
        assert_eq!(response.body, "ok");
        assert_eq!(response.size_bytes, 2);
        assert!(response.duration_ms >= response.ttfb_ms);
        assert_eq!(
            response.download_ms,
            response.duration_ms - response.ttfb_ms
        );
        // 本地 HTTP 地址可完成 DNS / TCP 探测，但不会产生 TLS 阶段。
        assert!(response.tcp_ms.is_some());
        assert!(response.tls_ms.is_none());

        handle.join().expect("server thread");
    }

    #[tokio::test]
    async fn rejects_non_http_scheme() {
        let error = send_with_cookie(
            get_payload("file:///etc/passwd"),
            Arc::new(Jar::default()),
            None,
        )
        .await
        .expect_err("file scheme should be rejected");
        assert!(error.contains("http/https"), "unexpected error: {error}");
    }

    #[tokio::test]
    async fn blocks_redirect_to_public_host_in_intranet_mode() {
        let (url, handle) = spawn_redirect_server("http://example.com/landing");
        let mut payload = get_payload(&url);
        payload.network = Some(NetworkOptions {
            mode: Some("B".to_string()),
            ..Default::default()
        });

        let error = send_with_cookie(payload, Arc::new(Jar::default()), None)
            .await
            .expect_err("redirect to public host should be blocked");
        assert!(
            error.contains("B 内网模式已阻止"),
            "unexpected error: {error}"
        );

        handle.join().expect("server thread");
    }

    fn spawn_http_server_with_length(body: &'static str) -> (String, thread::JoinHandle<()>) {
        spawn_http_server(body)
    }

    #[tokio::test]
    async fn truncates_oversized_response_body() {
        let body = "0123456789abcdef0123456789abcdef";
        let (url, handle) = spawn_http_server_with_length(body);
        let mut payload = get_payload(&url);
        payload.max_body_bytes = Some(8);
        payload.skip_probe = Some(true);

        let response = send_with_cookie(payload, Arc::new(Jar::default()), None)
            .await
            .expect("request should succeed");

        assert_eq!(response.body, "01234567");
        assert!(response.truncated);
        assert!(response.size_bytes >= response.body.len());

        handle.join().expect("server thread");
    }

    #[tokio::test]
    async fn keeps_small_response_untruncated() {
        let (url, handle) = spawn_http_server("ok");
        let mut payload = get_payload(&url);
        payload.max_body_bytes = Some(1024);
        payload.skip_probe = Some(true);

        let response = send_with_cookie(payload, Arc::new(Jar::default()), None)
            .await
            .expect("request should succeed");

        assert_eq!(response.body, "ok");
        assert!(!response.truncated);
        assert_eq!(response.size_bytes, 2);

        handle.join().expect("server thread");
    }

}
