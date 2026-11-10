use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{
    client_async_tls_with_config, connect_async_tls_with_config, Connector,
};

use crate::http::NetworkOptions;
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
    pub network: Option<NetworkOptions>,
}

#[derive(Debug)]
struct NoCertificateVerification;

impl ServerCertVerifier for NoCertificateVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::ED25519,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
        ]
    }
}

fn build_connector(network: Option<&NetworkOptions>) -> Result<Connector, String> {
    let accept_invalid = network
        .and_then(|options| options.accept_invalid_certs)
        .unwrap_or(false);

    let builder = if accept_invalid {
        rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoCertificateVerification))
    } else {
        let mut roots = rustls::RootCertStore::empty();
        for cert in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(cert);
        }
        rustls::ClientConfig::builder().with_root_certificates(roots)
    };

    let identity = network
        .and_then(|options| options.client_cert_path.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let config = if let Some(path) = identity {
        let pem = std::fs::read(path)
            .map_err(|error| format!("读取客户端证书失败：{error}"))?;

        let mut cert_reader = std::io::BufReader::new(pem.as_slice());
        let certs = rustls_pemfile::certs(&mut cert_reader)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("解析客户端证书失败：{error}"))?;

        let mut key_reader = std::io::BufReader::new(pem.as_slice());
        let key = rustls_pemfile::private_key(&mut key_reader)
            .map_err(|error| format!("解析客户端私钥失败：{error}"))?
            .ok_or_else(|| "客户端证书缺少私钥".to_string())?;

        builder
            .with_client_auth_cert(certs, key)
            .map_err(|error| format!("配置客户端证书失败：{error}"))?
    } else {
        builder.with_no_client_auth()
    };

    Ok(Connector::Rustls(Arc::new(config)))
}

fn proxy_address(network: Option<&NetworkOptions>) -> Result<Option<(String, u16)>, String> {
    let Some(proxy) = network
        .and_then(|options| options.proxy.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    let url = reqwest::Url::parse(proxy).map_err(|error| format!("代理地址无效：{error}"))?;
    if url.scheme() != "http" {
        return Err("WebSocket 仅支持 HTTP 代理".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("WebSocket 代理暂不支持用户名密码认证".to_string());
    }

    let host = url
        .host_str()
        .ok_or_else(|| "代理地址缺少主机名".to_string())?
        .to_string();
    let port = url.port_or_known_default().unwrap_or(8080);
    Ok(Some((host, port)))
}

async fn connect_proxy_tunnel(
    proxy: (String, u16),
    host: &str,
    port: u16,
) -> Result<TcpStream, String> {
    let mut stream = TcpStream::connect((proxy.0.as_str(), proxy.1))
        .await
        .map_err(|error| format!("连接代理失败：{error}"))?;

    let request = format!(
        "CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nProxy-Connection: keep-alive\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|error| format!("代理隧道写入失败：{error}"))?;

    let mut response = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| format!("代理隧道读取失败：{error}"))?;
        if read == 0 {
            return Err("代理连接已关闭".to_string());
        }
        response.extend_from_slice(&chunk[..read]);
        if response.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if response.len() > 32 * 1024 {
            return Err("代理响应过长".to_string());
        }
    }

    let head = String::from_utf8_lossy(&response);
    let status = head.lines().next().unwrap_or("");
    if !status.contains(" 200") {
        return Err(format!("代理隧道建立失败：{status}"));
    }

    Ok(stream)
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

    let parsed = reqwest::Url::parse(&payload.url)
        .map_err(|error| format!("WebSocket 地址无效：{error}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "WebSocket 地址缺少主机名".to_string())?
        .to_string();
    let port = parsed
        .port_or_known_default()
        .unwrap_or(if parsed.scheme() == "wss" { 443 } else { 80 });

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

    let connector = build_connector(payload.network.as_ref())?;
    let proxy = proxy_address(payload.network.as_ref())?;

    let (stream, _) = if let Some(proxy_address) = proxy {
        let tunnel = connect_proxy_tunnel(proxy_address, &host, port).await?;
        client_async_tls_with_config(request, tunnel, None, Some(connector))
            .await
            .map_err(|error| format!("WebSocket 连接失败：{error}"))?
    } else {
        connect_async_tls_with_config(request, None, false, Some(connector))
            .await
            .map_err(|error| format!("WebSocket 连接失败：{error}"))?
    };

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
