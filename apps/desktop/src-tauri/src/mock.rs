use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MockRoute {
    pub method: String,
    pub path: String,
    pub status: u16,
    #[serde(default)]
    pub body: String,
    pub content_type: Option<String>,
    pub delay_ms: Option<u64>,
}

pub struct MockServer {
    shutdown: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
pub struct MockState(pub Mutex<Option<MockServer>>);

fn normalize_path(path: &str) -> String {
    let without_query = path.split('?').next().unwrap_or("/");
    let trimmed = without_query.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        301 => "Moved Permanently",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "OK",
    }
}

fn stop_server(state: &MockState) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut server) = guard.take() {
            if let Some(sender) = server.shutdown.take() {
                let _ = sender.send(());
            }
        }
    }
}

#[tauri::command]
pub async fn start_mock_server(
    state: State<'_, MockState>,
    port: u16,
    routes: Vec<MockRoute>,
) -> Result<u16, String> {
    stop_server(&state);

    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|error| format!("无法监听 127.0.0.1:{port}：{error}"))?;
    let actual_port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let shared_routes = Arc::new(routes);

    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => break,
                accepted = listener.accept() => {
                    let Ok((mut stream, _)) = accepted else { continue };
                    let routes = shared_routes.clone();
                    tokio::spawn(async move {
                        let mut buffer = [0u8; 16 * 1024];
                        let read = match stream.read(&mut buffer).await {
                            Ok(read) => read,
                            Err(_) => return,
                        };
                        let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                        let mut lines = request.lines();
                        let request_line = lines.next().unwrap_or("");
                        let mut parts = request_line.split_whitespace();
                        let method = parts.next().unwrap_or("GET").to_uppercase();
                        let raw_path = parts.next().unwrap_or("/");
                        let path = normalize_path(raw_path);

                        if method == "OPTIONS" {
                            let response = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET,POST,PUT,PATCH,DELETE,OPTIONS\r\nAccess-Control-Allow-Headers: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                            let _ = stream.write_all(response.as_bytes()).await;
                            return;
                        }

                        let matched = routes.iter().find(|route| {
                            route.method.eq_ignore_ascii_case(&method)
                                && normalize_path(&route.path) == path
                        });

                        let (status, body, content_type) = match matched {
                            Some(route) => {
                                if let Some(delay) = route.delay_ms {
                                    if delay > 0 {
                                        tokio::time::sleep(Duration::from_millis(delay)).await;
                                    }
                                }
                                (
                                    route.status,
                                    route.body.clone(),
                                    route
                                        .content_type
                                        .clone()
                                        .filter(|value| !value.trim().is_empty())
                                        .unwrap_or_else(|| "application/json; charset=utf-8".to_string()),
                                )
                            }
                            None => (
                                404,
                                format!("{{\"error\":\"未找到 Mock 路由：{method} {path}\"}}"),
                                "application/json; charset=utf-8".to_string(),
                            ),
                        };

                        let response = format!(
                            "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {length}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Methods: *\r\nConnection: close\r\n\r\n{body}",
                            reason = reason_phrase(status),
                            length = body.as_bytes().len(),
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.shutdown().await;
                    });
                }
            }
        }
    });

    if let Ok(mut guard) = state.0.lock() {
        *guard = Some(MockServer {
            shutdown: Some(shutdown_tx),
        });
    }

    Ok(actual_port)
}

#[tauri::command]
pub fn stop_mock_server(state: State<'_, MockState>) -> Result<(), String> {
    stop_server(&state);
    Ok(())
}
