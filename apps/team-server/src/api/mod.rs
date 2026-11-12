pub mod admin;
pub mod audit;
pub mod auth;
pub mod members;
pub mod meta;
pub mod permissions;
pub mod snapshots;
pub mod teams;

#[cfg(test)]
mod tests;

use axum::routing::{get, patch, post, put};
use axum::Router;

use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(admin::root))
        .route("/admin", get(admin::page))
        .route("/admin/", get(admin::page))
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
        .route(
            "/v1/teams/{team_id}/members",
            get(teams::list_members).post(members::add_member),
        )
        .route(
            "/v1/teams/{team_id}/members/{user_id}",
            patch(members::update_member_role).delete(members::remove_member),
        )
        .route(
            "/v1/teams/{team_id}/members/{user_id}/reset-password",
            post(members::reset_password),
        )
        .route(
            "/v1/teams/{team_id}/access",
            get(permissions::get_access),
        )
        .route(
            "/v1/teams/{team_id}/workspace",
            get(permissions::get_workspace),
        )
        .route(
            "/v1/teams/{team_id}/permissions",
            get(permissions::list_permissions).post(permissions::batch_update_permissions),
        )
        .route(
            "/v1/teams/{team_id}/permissions/{resource_type}/{resource_id}",
            put(permissions::update_permission).delete(permissions::reset_permission),
        )
        .route(
            "/v1/teams/{team_id}/snapshots",
            get(snapshots::list_snapshots).post(snapshots::push_snapshot),
        )
        .route(
            "/v1/teams/{team_id}/snapshots/latest",
            get(snapshots::get_latest),
        )
        .route(
            "/v1/teams/{team_id}/snapshots/{revision}",
            get(snapshots::get_snapshot),
        )
        .route(
            "/v1/teams/{team_id}/snapshots/{revision}/rollback",
            post(snapshots::rollback_snapshot),
        )
        .route("/v1/teams/{team_id}/audit", get(audit::list_audit))
        .route(
            "/v1/teams/{team_id}/presence",
            get(crate::presence::presence_ws),
        )
        .with_state(state)
}
