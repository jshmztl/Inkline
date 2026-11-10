use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::Message;

use crate::model::HeaderPair;
use crate::sse::{emit, StreamEvent};

pub struct WsConnection {
    sender: mpsc::UnboundedSender<Message>,
}

#[derive(Default, Clone)]
pub struct WsState(pub Arc<Mutex<HashMap<String, WsConnection>>>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsPayload {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<HeaderPair>,
}

#[tauri::command]
pub async fn ws_connect(
    state: State<'_, WsState>,
    payload: WsPayload,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    if !payload.url.starts_with("ws://") && !payload.url.starts_with("wss://") {
        return Err("WebSocket 地址需以 ws:// 或 wss:// 开头".to_string());
    }

    let mut request = payload
        .url
        .as_str()
        .into_client_request()
        .map_err(|error| format!("WebSocket 地址无效：{error}"))?;

    for header in &payload.headers {
        if header.name.trim().is_empty() {
            continue;
        }
        let name = HeaderName::from_bytes(header.name.trim().as_bytes())
            .map_err(|error| format!("请求头名称无效：{error}"))?;
        let value = HeaderValue::from_str(&header.value)
            .map_err(|error| format!("请求头值无效：{error}"))?;
        request.headers_mut().insert(name, value);
    }

    let (stream, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|error| format!("WebSocket 连接失败：{error}"))?;

    let (mut write, mut read) = stream.split();
    let (sender, mut receiver) = mpsc::unbounded_channel::<Message>();

    {
        let mut guard = state.0.lock().map_err(|error| error.to_string())?;
        guard.insert(
            payload.id.clone(),
            WsConnection {
                sender: sender.clone(),
            },
        );
    }

    tauri::async_runtime::spawn(async move {
        while let Some(message) = receiver.recv().await {
            let closing = matches!(message, Message::Close(_));
            if write.send(message).await.is_err() {
                break;
            }
            if closing {
                break;
            }
        }
    });

    emit(&on_event, "open", "连接已建立");

    let connections = state.0.clone();
    let stream_id = payload.id.clone();

    tauri::async_runtime::spawn(async move {
        loop {
            match read.next().await {
                Some(Ok(Message::Text(text))) => {
                    emit(&on_event, "message", text.as_str());
                }
                Some(Ok(Message::Binary(bytes))) => {
                    emit(&on_event, "message", &format!("[二进制 {} 字节]", bytes.len()));
                }
                Some(Ok(Message::Close(frame))) => {
                    let reason = frame.map(|frame| frame.reason.to_string()).unwrap_or_default();
                    let text = if reason.is_empty() {
                        "连接已关闭".to_string()
                    } else {
                        format!("连接已关闭 · {reason}")
                    };
                    emit(&on_event, "close", &text);
                    break;
                }
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Frame(_))) => {}
                Some(Err(error)) => {
                    emit(&on_event, "error", &format!("WebSocket 错误：{error}"));
                    break;
                }
                None => {
                    emit(&on_event, "close", "连接已关闭");
                    break;
                }
            }
        }

        if let Ok(mut guard) = connections.lock() {
            guard.remove(&stream_id);
        }
    });

    Ok(())
}

#[tauri::command]
pub fn ws_send(state: State<'_, WsState>, id: String, message: String) -> Result<(), String> {
    let guard = state.0.lock().map_err(|error| error.to_string())?;
    let connection = guard
        .get(&id)
        .ok_or_else(|| "WebSocket 未连接".to_string())?;
    connection
        .sender
        .send(Message::Text(message.into()))
        .map_err(|_| "WebSocket 已断开".to_string())
}

#[tauri::command]
pub fn ws_close(state: State<'_, WsState>, id: String) -> Result<(), String> {
    let guard = state.0.lock().map_err(|error| error.to_string())?;
    if let Some(connection) = guard.get(&id) {
        let _ = connection.sender.send(Message::Close(None));
    }
    Ok(())
}
