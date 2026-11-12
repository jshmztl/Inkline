use std::sync::Arc;

use sqlx::PgPool;

use crate::config::Config;
use crate::presence::PresenceState;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<Config>,
    pub presence: PresenceState,
}
