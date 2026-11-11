pub mod audit;
pub mod auth;
pub mod meta;
pub mod snapshots;
pub mod teams;

use axum::routing::{get, post};
use axum::Router;

use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(meta::healthz))
        .route("/readyz", get(meta::readyz))
        .route("/v1/meta", get(meta::meta))
        .route("/v1/auth/login", post(auth::login))
        .route("/v1/auth/refresh", post(auth::refresh))
        .route("/v1/auth/logout", post(auth::logout))
        .route("/v1/me", get(auth::me))
        .route("/v1/teams", get(teams::list_teams).post(teams::create_team))
        .route(
            "/v1/teams/{team_id}",
            get(teams::get_team).patch(teams::update_team),
        )
        .route("/v1/teams/{team_id}/members", get(teams::list_members))
        .route(
            "/v1/teams/{team_id}/snapshots",
            post(snapshots::push_snapshot),
        )
        .route(
            "/v1/teams/{team_id}/snapshots/latest",
            get(snapshots::get_latest),
        )
        .route(
            "/v1/teams/{team_id}/snapshots/{revision}",
            get(snapshots::get_snapshot),
        )
        .route("/v1/teams/{team_id}/audit", get(audit::list_audit))
        .with_state(state)
}
