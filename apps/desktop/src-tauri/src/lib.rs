mod db;
mod http;
mod model;

use std::sync::Mutex;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let connection = db::open(app.handle())?;
            app.manage(db::DbState(Mutex::new(connection)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            http::send_http_request,
            db::save_request,
            db::list_requests,
            db::record_history,
            db::list_history
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
