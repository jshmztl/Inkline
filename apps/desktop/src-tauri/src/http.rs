use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::multipart::{Form, Part};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::oneshot;

use crate::model::HeaderPair;

#[derive(Default)]
pub struct CancelState(pub Mutex<HashMap<String, oneshot::Sender<()>>>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultipartField {
    pub name: String,
    pub value: Option<String>,
    pub file_name: Option<String>,
    pub file_base64: Option<String>,
    pub content_type: Option<String>,
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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<HeaderPair>,
    pub body: String,
    pub duration_ms: u64,
    pub size_bytes: usize,
}

#[tauri::command]
pub async fn send_http_request(
    payload: SendRequestPayload,
    cancel: State<'_, CancelState>,
) -> Result<SendResponse, String> {
    let url = reqwest::Url::parse(&payload.url).map_err(|error| format!("URL 无效：{error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("仅支持 http/https 请求".to_string());
    }

    let method = Method::from_bytes(payload.method.to_uppercase().as_bytes())
        .map_err(|error| format!("请求方法无效：{error}"))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(payload.timeout_ms.unwrap_or(30_000)))
        .build()
        .map_err(|error| format!("创建 HTTP 客户端失败：{error}"))?;

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
    let request_id = payload.id.clone();
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();

    if let Some(id) = &request_id {
        cancel
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .insert(id.clone(), cancel_tx);
    }

    let work = async {
        let response = request
            .send()
            .await
            .map_err(|error| format!("请求失败：{error}"))?;

        let status = response.status();
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| HeaderPair {
                name: name.to_string(),
                value: value.to_str().unwrap_or("").to_string(),
            })
            .collect();
        let body = response
            .text()
            .await
            .map_err(|error| format!("读取响应失败：{error}"))?;
        let size_bytes = body.len();

        Ok::<SendResponse, String>(SendResponse {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").to_string(),
            headers,
            body,
            duration_ms: started.elapsed().as_millis() as u64,
            size_bytes,
        })
    };

    let result = if request_id.is_some() {
        tokio::select! {
            result = work => result,
            _ = cancel_rx => Err("请求已取消".to_string()),
        }
    } else {
        work.await
    };

    if let Some(id) = &request_id {
        if let Ok(mut pending) = cancel.0.lock() {
            pending.remove(id);
        }
    }

    result
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
