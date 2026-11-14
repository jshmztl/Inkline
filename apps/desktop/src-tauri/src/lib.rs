mod ai;
mod db;
mod http;
mod mock;
mod model;
mod netpolicy;
mod netprobe;
mod secrets;
mod sse;
mod timing;
mod ws;

use std::sync::Mutex;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let connection = db::open(app.handle())?;
            app.manage(db::DbState(Mutex::new(connection)));
            app.manage(http::CancelState::default());
            app.manage(http::CookieState::default());
            app.manage(sse::SseState::default());
            app.manage(ws::WsState::default());
            app.manage(mock::MockState::default());

            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            http::send_http_request,
            http::cancel_http_request,
            http::clear_cookies,
            sse::start_sse_stream,
            sse::cancel_sse,
            ws::ws_connect,
            ws::ws_send,
            ws::ws_close,
            netprobe::probe_network,
            netpolicy::check_network_access,
            mock::start_mock_server,
            mock::stop_mock_server,
            ai::ai_chat,
            ai::ai_chat_stream,
            db::save_request,
            db::list_requests,
            db::delete_request,
            db::list_collections,
            db::save_collection,
            db::delete_collection,
            db::record_history,
            db::list_history,
            db::clear_history,
            db::delete_history,
            db::record_audit,
            db::list_audit,
            db::clear_audit,
            db::load_settings,
            db::save_settings,
            db::delete_settings,
            secrets::save_secret,
            secrets::load_secret,
            secrets::load_all_secrets,
            secrets::delete_secret
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
