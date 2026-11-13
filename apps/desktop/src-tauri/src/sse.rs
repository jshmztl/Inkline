use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::oneshot;

use crate::http::NetworkOptions;
use crate::model::HeaderPair;
use crate::netpolicy::redirect_policy;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamEvent {
    pub id: String,
    pub kind: String,
    pub at: u64,
    pub payload: String,
    pub label: Option<String>,
    pub event_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsePayload {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<HeaderPair>,
    pub body: Option<String>,
    pub network: Option<NetworkOptions>,
}

#[derive(Default)]
pub struct SseState(pub Mutex<HashMap<String, oneshot::Sender<()>>>);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn emit(channel: &Channel<StreamEvent>, kind: &str, payload: &str) {
    emit_event(channel, kind, payload, None, None);
}

pub(crate) fn emit_event(
    channel: &Channel<StreamEvent>,
    kind: &str,
    payload: &str,
    label: Option<String>,
    event_id: Option<String>,
) {
    let at = now_ms();
    let _ = channel.send(StreamEvent {
        id: format!("evt-{at}-{kind}"),
        kind: kind.to_string(),
        at,
        payload: payload.to_string(),
        label,
        event_id,
    });
}

/// 返回事件数据区结束位置与分隔符长度，用于按空行切分 SSE 事件。
fn find_event_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    let mut index = 0;
    while index + 1 < buffer.len() {
        if buffer[index] == b'\n' && buffer[index + 1] == b'\n' {
            return Some((index, 2));
        }
        if index + 3 < buffer.len()
            && buffer[index] == b'\r'
            && buffer[index + 1] == b'\n'
            && buffer[index + 2] == b'\r'
            && buffer[index + 3] == b'\n'
        {
            return Some((index, 4));
        }
        index += 1;
    }
    None
}

struct ParsedEvent {
    data: String,
    event: Option<String>,
    id: Option<String>,
}

fn parse_event(raw: &[u8]) -> ParsedEvent {
    let text = String::from_utf8_lossy(raw);
    let mut data: Vec<&str> = Vec::new();
    let mut event = None;
    let mut id = None;

    for line in text.lines() {
        if let Some(value) = line.strip_prefix("data:") {
            data.push(value.strip_prefix(' ').unwrap_or(value));
        } else if let Some(value) = line.strip_prefix("event:") {
            event = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("id:") {
            id = Some(value.trim().to_string());
        }
    }

    ParsedEvent {
        data: data.join("\n"),
        event,
        id,
    }
}

#[tauri::command]
pub async fn start_sse_stream(
    state: State<'_, SseState>,
    payload: SsePayload,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let url = reqwest::Url::parse(&payload.url)
        .map_err(|error| format!("SSE 地址无效：{error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("SSE 仅支持 http/https 地址".to_string());
    }

    let policy = payload
        .network
        .as_ref()
        .map(NetworkOptions::policy)
        .unwrap_or_default();
    policy.ensure_allowed_resolved(&payload.url).await?;

    let mut client = reqwest::Client::builder().connect_timeout(Duration::from_secs(15));

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
        .map_err(|error| format!("创建 SSE 客户端失败：{error}"))?;

    let method = if payload
        .body
        .as_deref()
        .map(|value| !value.is_empty())
        .unwrap_or(false)
    {
        reqwest::Method::POST
    } else {
        reqwest::Method::GET
    };

    let mut request = client.request(method, url);
    for header in &payload.headers {
        if header.name.trim().is_empty() || header.name.eq_ignore_ascii_case("accept") {
            continue;
        }
        request = request.header(header.name.trim(), header.value.as_str());
    }
    request = request.header("Accept", "text/event-stream");
    if let Some(body) = payload.body.as_deref().filter(|value| !value.is_empty()) {
        request = request.body(body.to_string());
    }

    let stream_id = payload.id.clone();
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    state
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .insert(stream_id.clone(), cancel_tx);

    let result = async {
        let response = request
            .send()
            .await
            .map_err(|error| format!("SSE 连接失败：{error}"))?;

        let status = response.status();
        if !status.is_success() {
            return Err(format!(
                "SSE 连接失败：{} {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("")
            ));
        }

        emit(&on_event, "open", "流已建立");
        let mut stream = response.bytes_stream();
        let mut buffer: Vec<u8> = Vec::new();

        loop {
            tokio::select! {
                _ = &mut cancel_rx => {
                    emit(&on_event, "close", "流已断开");
                    return Ok(());
                }
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(bytes)) => {
                            buffer.extend_from_slice(&bytes);
                            while let Some((boundary, length)) = find_event_boundary(&buffer) {
                                let raw: Vec<u8> = buffer.drain(..boundary).collect();
                                buffer.drain(..length);
                                let parsed = parse_event(&raw);
                                if !parsed.data.is_empty() || parsed.event.is_some() {
                                    emit_event(
                                        &on_event,
                                        "message",
                                        &parsed.data,
                                        parsed.event,
                                        parsed.id,
                                    );
                                }
                            }
                        }
                        Some(Err(error)) => {
                            emit(&on_event, "error", &format!("读取 SSE 失败：{error}"));
                            return Ok(());
                        }
                        None => {
                            emit(&on_event, "close", "流已结束");
                            return Ok(());
                        }
                    }
                }
            }
        }
    }
    .await;

    if let Ok(mut pending) = state.0.lock() {
        pending.remove(&stream_id);
    }

    result
}

#[tauri::command]
pub fn cancel_sse(state: State<'_, SseState>, id: String) -> Result<(), String> {
    if let Ok(mut pending) = state.0.lock() {
        if let Some(sender) = pending.remove(&id) {
            let _ = sender.send(());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_events_on_blank_lines() {
        let buffer = b"data: hello\n\ndata: world\n\n";
        let (boundary, length) = find_event_boundary(buffer).expect("first boundary");
        assert_eq!(&buffer[..boundary], b"data: hello");
        assert_eq!(length, 2);
        assert_eq!(parse_event(&buffer[..boundary]).data, "hello");
    }

    #[test]
    fn supports_crlf_and_multi_line_data() {
        let buffer = b"data: line1\r\ndata: line2\r\n\r\n";
        let (boundary, length) = find_event_boundary(buffer).expect("boundary");
        assert_eq!(length, 4);
        assert_eq!(parse_event(&buffer[..boundary]).data, "line1\nline2");
    }

    #[test]
    fn parses_event_name_and_id() {
        let parsed = parse_event(b"event: update\nid: 42\ndata: payload");
        assert_eq!(parsed.event.as_deref(), Some("update"));
        assert_eq!(parsed.id.as_deref(), Some("42"));
        assert_eq!(parsed.data, "payload");
    }
}
