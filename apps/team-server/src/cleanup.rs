use std::time::Duration;

use sqlx::PgPool;

#[derive(Debug, Default)]
pub struct CleanupStats {
    pub snapshots: u64,
    pub audits: u64,
    pub decrypt_audits: u64,
    pub refresh_tokens: u64,
}

pub async fn run_once(
    pool: &PgPool,
    default_audit_retention_days: i32,
) -> Result<CleanupStats, sqlx::Error> {
    // 每个团队至少保留最新一个快照，避免清理后无法拉取。
    let snapshots = sqlx::query(
        "DELETE FROM snapshots s
         USING teams t
         WHERE s.team_id = t.id
           AND s.created_at < now() - make_interval(days => t.snapshot_retention_days)
           AND s.revision < (
               SELECT max(latest.revision) FROM snapshots latest WHERE latest.team_id = s.team_id
           )",
    )
    .execute(pool)
    .await?
    .rows_affected();

    let team_audits = sqlx::query(
        "DELETE FROM audit_logs a
         USING teams t
         WHERE a.team_id = t.id
           AND a.at < now() - make_interval(days => t.audit_retention_days)",
    )
    .execute(pool)
    .await?
    .rows_affected();

    let orphan_audits = sqlx::query(
        "DELETE FROM audit_logs
         WHERE team_id IS NULL
           AND at < now() - make_interval(days => $1)",
    )
    .bind(default_audit_retention_days)
    .execute(pool)
    .await?
    .rows_affected();

    // 解密审计默认只追加；保留期清理通过会话标记显式放行 DELETE。
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL inkline.audit_retention = 'on'")
        .execute(&mut *tx)
        .await?;
    let decrypt_audits: i64 = sqlx::query_scalar(
        "WITH deleted AS (
             DELETE FROM admin_decrypt_audit a
             WHERE a.created_at < now() - make_interval(days => COALESCE(
                 (SELECT t.audit_retention_days FROM teams t WHERE t.id = a.team_id),
                 $1
             ))
             RETURNING 1
         )
         SELECT count(*) FROM deleted",
    )
    .bind(default_audit_retention_days)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    let decrypt_audits = decrypt_audits.max(0) as u64;

    let refresh_tokens = sqlx::query(
        "DELETE FROM refresh_tokens
         WHERE expires_at < now() - interval '7 days'
            OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')",
    )
    .execute(pool)
    .await?
    .rows_affected();

    Ok(CleanupStats {
        snapshots,
        audits: team_audits + orphan_audits,
        decrypt_audits,
        refresh_tokens,
    })
}

pub fn spawn(pool: PgPool, interval_hours: u64, default_audit_retention_days: i32) {
    let period = Duration::from_secs(interval_hours.saturating_mul(3600));
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(period).await;
            match run_once(&pool, default_audit_retention_days).await {
                Ok(stats) => tracing::info!(
                    snapshots = stats.snapshots,
                    audits = stats.audits,
                    decrypt_audits = stats.decrypt_audits,
                    refresh_tokens = stats.refresh_tokens,
                    "保留期清理完成"
                ),
                Err(error) => tracing::warn!(error = %error, "保留期清理失败"),
            }
        }
    });
}
