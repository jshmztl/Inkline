use keyring::Entry;

const SERVICE: &str = "com.inkline.desktop";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|error| format!("无法访问系统凭据库：{error}"))
}

#[tauri::command]
pub fn save_secret(key: String, value: String) -> Result<(), String> {
    entry(&key)?
        .set_password(&value)
        .map_err(|error| format!("保存凭据失败：{error}"))
}

#[tauri::command]
pub fn load_secret(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("读取凭据失败：{error}")),
    }
}

#[tauri::command]
pub fn delete_secret(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("删除凭据失败：{error}")),
    }
}
