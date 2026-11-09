use std::time::{Duration, Instant};

use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::model::HeaderPair;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequestPayload {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<HeaderPair>,
    pub body: Option<String>,
    pub timeout_ms: Option<u64>,
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
pub async fn send_http_request(payload: SendRequestPayload) -> Result<SendResponse, String> {
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
        request = request.header(header.name.trim(), header.value.as_str());
    }

    if let Some(body) = payload.body {
        if !body.is_empty() {
            request = request.body(body);
        }
    }

    let started = Instant::now();
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

    Ok(SendResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        body,
        duration_ms: started.elapsed().as_millis() as u64,
        size_bytes,
    })
}
