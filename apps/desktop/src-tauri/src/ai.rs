use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::http::NetworkOptions;
use crate::netpolicy::redirect_policy;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AiMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatPayload {
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub messages: Vec<AiMessage>,
    pub temperature: Option<f32>,
    pub timeout_ms: Option<u64>,
    pub network: Option<NetworkOptions>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatResult {
    pub content: String,
    pub model: String,
}

#[tauri::command]
pub async fn ai_chat(payload: AiChatPayload) -> Result<AiChatResult, String> {
    let base = payload.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("AI 网关地址为空".to_string());
    }
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("AI 网关地址需要以 http:// 或 https:// 开头".to_string());
    }

    let url = format!("{base}/chat/completions");
    let policy = payload
        .network
        .as_ref()
        .map(NetworkOptions::policy)
        .unwrap_or_default();
    policy.ensure_allowed_resolved(&url).await?;
    let follow_redirects = payload
        .network
        .as_ref()
        .and_then(|network| network.follow_redirects)
        .unwrap_or(true);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(payload.timeout_ms.unwrap_or(60_000)))
        .redirect(if follow_redirects {
            redirect_policy(policy)
        } else {
            reqwest::redirect::Policy::none()
        })
        .build()
        .map_err(|error| format!("创建 AI 客户端失败：{error}"))?;

    let mut request = client.post(&url).json(&serde_json::json!({
        "model": payload.model.clone(),
        "messages": payload.messages,
        "temperature": payload.temperature.unwrap_or(0.2),
        "stream": false,
    }));

    if let Some(key) = payload.api_key.as_deref().map(str::trim) {
        if !key.is_empty() {
            request = request.bearer_auth(key);
        }
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("AI 网关请求失败：{error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取 AI 网关响应失败：{error}"))?;

    if !status.is_success() {
        return Err(format!("AI 网关返回 {status}：{text}"));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("AI 响应不是合法 JSON：{error}"))?;
    let content = parsed["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    if content.is_empty() {
        return Err("AI 网关响应缺少 choices[0].message.content".to_string());
    }

    let model = parsed["model"]
        .as_str()
        .unwrap_or(&payload.model)
        .to_string();

    Ok(AiChatResult { content, model })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamChunk {
    pub delta: String,
    pub done: bool,
}

#[tauri::command]
pub async fn ai_chat_stream(
    payload: AiChatPayload,
    on_event: Channel<AiStreamChunk>,
) -> Result<AiChatResult, String> {
    let base = payload.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("AI 网关地址为空".to_string());
    }
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("AI 网关地址需要以 http:// 或 https:// 开头".to_string());
    }

    let url = format!("{base}/chat/completions");
    let policy = payload
        .network
        .as_ref()
        .map(NetworkOptions::policy)
        .unwrap_or_default();
    policy.ensure_allowed_resolved(&url).await?;
    let follow_redirects = payload
        .network
        .as_ref()
        .and_then(|network| network.follow_redirects)
        .unwrap_or(true);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(payload.timeout_ms.unwrap_or(120_000)))
        .redirect(if follow_redirects {
            redirect_policy(policy)
        } else {
            reqwest::redirect::Policy::none()
        })
        .build()
        .map_err(|error| format!("创建 AI 客户端失败：{error}"))?;

    let mut request = client.post(&url).json(&serde_json::json!({
        "model": payload.model.clone(),
        "messages": payload.messages,
        "temperature": payload.temperature.unwrap_or(0.2),
        "stream": true,
    }));

    if let Some(key) = payload.api_key.as_deref().map(str::trim) {
        if !key.is_empty() {
            request = request.bearer_auth(key);
        }
    }

    let mut response = request
        .send()
        .await
        .map_err(|error| format!("AI 网关请求失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("AI 网关返回 {status}：{text}"));
    }

    let mut content = String::new();
    let mut model = payload.model.clone();
    let mut buffer = String::new();

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取 AI 流失败：{error}"))?
    {
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        loop {
            let Some(line_end) = buffer.find('\n') else {
                break;
            };
            let line = buffer[..line_end].trim_end_matches('\r').to_string();
            buffer.drain(..=line_end);
            let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                continue;
            };
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };
            if let Some(name) = parsed["model"].as_str() {
                model = name.to_string();
            }
            if let Some(delta) = parsed["choices"][0]["delta"]["content"].as_str() {
                if !delta.is_empty() {
                    content.push_str(delta);
                    on_event
                        .send(AiStreamChunk {
                            delta: delta.to_string(),
                            done: false,
                        })
                        .map_err(|error| error.to_string())?;
                }
            }
        }
    }

    if content.trim().is_empty() {
        return Err("AI 网关流式响应为空".to_string());
    }

    on_event
        .send(AiStreamChunk {
            delta: String::new(),
            done: true,
        })
        .map_err(|error| error.to_string())?;

    Ok(AiChatResult { content, model })
}
