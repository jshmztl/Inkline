use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::Response;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::auth::verify_access_token;
use crate::db;
use crate::state::AppState;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceMember {
    pub user_id: Uuid,
    pub account: String,
    pub display_name: String,
    pub role: String,
    pub connections: usize,
    pub connected_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Clone, Default)]
pub struct PresenceState {
    inner: Arc<Mutex<HashMap<Uuid, HashMap<Uuid, PresenceMember>>>>,
    channels: Arc<Mutex<HashMap<Uuid, broadcast::Sender<Vec<PresenceMember>>>>>,
}

#[derive(Debug, Deserialize)]
struct AuthMessage {
    #[serde(rename = "type")]
    kind: String,
    token: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Outgoing {
    Presence { members: Vec<PresenceMember> },
    Pong,
    Error { message: String },
}

impl PresenceState {
    fn channel(&self, team_id: Uuid) -> broadcast::Sender<Vec<PresenceMember>> {
        let mut channels = self.channels.lock().expect("presence channels");
        channels
            .entry(team_id)
            .or_insert_with(|| broadcast::channel(64).0)
            .clone()
    }

    fn members(&self, team_id: Uuid) -> Vec<PresenceMember> {
        let inner = self.inner.lock().expect("presence members");
        let mut list = inner
            .get(&team_id)
            .map(|members| members.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        list.sort_by(|left, right| left.display_name.cmp(&right.display_name));
        list
    }

    fn join(&self, team_id: Uuid, member: PresenceMember) -> broadcast::Receiver<Vec<PresenceMember>> {
        let receiver = self.channel(team_id).subscribe();
        {
            let mut inner = self.inner.lock().expect("presence members");
            inner
                .entry(team_id)
                .or_default()
                .entry(member.user_id)
                .and_modify(|existing| {
                    existing.connections += 1;
                    existing.account = member.account.clone();
                    existing.display_name = member.display_name.clone();
                    existing.role = member.role.clone();
                })
                .or_insert(member);
        }
        self.broadcast(team_id);
        receiver
    }

    fn leave(&self, team_id: Uuid, user_id: Uuid) {
        {
            let mut inner = self.inner.lock().expect("presence members");
            let mut remove_team = false;
            if let Some(members) = inner.get_mut(&team_id) {
                if let Some(member) = members.get_mut(&user_id) {
                    member.connections = member.connections.saturating_sub(1);
                    if member.connections == 0 {
                        members.remove(&user_id);
                    }
                }
                remove_team = members.is_empty();
            }
            if remove_team {
                inner.remove(&team_id);
            }
        }
        self.broadcast(team_id);
    }

    fn broadcast(&self, team_id: Uuid) {
        let members = self.members(team_id);
        if let Some(sender) = self
            .channels
            .lock()
            .expect("presence channels")
            .get(&team_id)
        {
            let _ = sender.send(members);
        }
    }
}

pub async fn presence_ws(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(team_id): Path<Uuid>,
) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state, team_id))
}

async fn handle_socket(mut socket: WebSocket, state: AppState, team_id: Uuid) {
    let auth = tokio::time::timeout(Duration::from_secs(5), socket.next()).await;
    let Ok(Some(Ok(Message::Text(text)))) = auth else {
        let _ = socket
            .send(Message::Text(
                serde_json::to_string(&Outgoing::Error {
                    message: "缺少在线状态认证".to_string(),
                })
                .unwrap_or_default()
                .into(),
            ))
            .await;
        return;
    };

    let Ok(message) = serde_json::from_str::<AuthMessage>(&text) else {
        return;
    };
    if message.kind != "auth" {
        return;
    }
    let Some(token) = message.token else {
        return;
    };
    let Ok(claims) = verify_access_token(&state.config.jwt_secret, &token) else {
        let _ = socket
            .send(Message::Text(
                serde_json::to_string(&Outgoing::Error {
                    message: "访问令牌无效或已过期".to_string(),
                })
                .unwrap_or_default()
                .into(),
            ))
            .await;
        return;
    };
    let user_id = claims.sub;

    let Ok(Some(role)) = db::membership_role(&state.pool, team_id, user_id).await else {
        let _ = socket
            .send(Message::Text(
                serde_json::to_string(&Outgoing::Error {
                    message: "不是该团队成员".to_string(),
                })
                .unwrap_or_default()
                .into(),
            ))
            .await;
        return;
    };

    let Ok(Some((account, display_name))) =
        sqlx::query_as::<_, (String, String)>(
            "SELECT account, display_name FROM users WHERE id = $1",
        )
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await
    else {
        return;
    };

    let mut receiver = state.presence.join(
        team_id,
        PresenceMember {
            user_id,
            account,
            display_name,
            role,
            connections: 1,
            connected_at: chrono::Utc::now(),
        },
    );

    if let Ok(payload) = serde_json::to_string(&Outgoing::Presence {
        members: state.presence.members(team_id),
    }) {
        if socket.send(Message::Text(payload.into())).await.is_err() {
            state.presence.leave(team_id, user_id);
            return;
        }
    }

    loop {
        tokio::select! {
            incoming = socket.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if text.to_ascii_lowercase().contains("\"ping\"") {
                            let payload = serde_json::to_string(&Outgoing::Pong).unwrap_or_default();
                            if socket.send(Message::Text(payload.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
            broadcast = receiver.recv() => {
                match broadcast {
                    Ok(members) => {
                        let payload = serde_json::to_string(&Outgoing::Presence { members }).unwrap_or_default();
                        if socket.send(Message::Text(payload.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    state.presence.leave(team_id, user_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(id: Uuid, name: &str) -> PresenceMember {
        PresenceMember {
            user_id: id,
            account: name.to_string(),
            display_name: name.to_string(),
            role: "member".to_string(),
            connections: 1,
            connected_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn joins_and_leaves_track_connections() {
        let state = PresenceState::default();
        let team = Uuid::new_v4();
        let user = Uuid::new_v4();
        let first = state.join(team, member(user, "张三"));
        drop(first);
        assert_eq!(state.members(team).len(), 1);

        let second = state.join(team, member(user, "张三"));
        drop(second);
        assert_eq!(state.members(team)[0].connections, 2);

        state.leave(team, user);
        assert_eq!(state.members(team)[0].connections, 1);

        state.leave(team, user);
        assert!(state.members(team).is_empty());
    }
}
