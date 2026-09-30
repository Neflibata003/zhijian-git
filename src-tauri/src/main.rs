#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod git;
use std::sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex};
use tauri::{Emitter, Manager};

struct AppState {
    gate: Arc<Mutex<()>>,
    cancel: Arc<AtomicU64>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

/// 从命令行参数取出第一个存在的文件夹（右键菜单以 "%V" 传入）。
fn folder_from_args(args: &[String]) -> Option<String> {
    args.iter().skip(1).find(|a| !a.starts_with('-') && std::path::Path::new(a).is_dir()).cloned()
}

#[tauri::command]
fn initial_path() -> Option<String> { folder_from_args(&std::env::args().collect::<Vec<_>>()) }

#[tauri::command]
async fn request(app: tauri::AppHandle, state: tauri::State<'_, AppState>, op: String, path: Option<String>, args: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let gate = state.gate.clone();
    let cancel = state.cancel.clone();
    let generation = cancel.load(Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = gate.lock().map_err(|_| "任务队列不可用")?;
        if generation != cancel.load(Ordering::Relaxed) { return Err("任务已取消".into()); }
        git::dispatch(&app, &op, path.as_deref(), args.unwrap_or(serde_json::json!({})), &cancel, generation)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_task(state: tauri::State<'_, AppState>) { state.cancel.fetch_add(1, Ordering::Relaxed); }

/// 只监听当前项目：根目录及前 512 个子目录（非递归），外加 .git 内的索引与引用。
#[tauri::command]
async fn watch_project(app: tauri::AppHandle, state: tauri::State<'_, AppState>, path: Option<String>) -> Result<(), String> {
    use notify::Watcher;
    *state.watcher.lock().map_err(|_| "监听器不可用")? = None;
    let Some(path) = path else { return Ok(()); };
    let root = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let mut dirs = vec![root.clone()];
    let mut cursor = 0;
    while cursor < dirs.len() && dirs.len() < 512 {
        if let Ok(entries) = std::fs::read_dir(&dirs[cursor]) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if [".git", "node_modules", "target", ".venv", "dist"].contains(&name.as_str()) { continue; }
                if entry.file_type().map(|t| t.is_dir() && !t.is_symlink()).unwrap_or(false) { dirs.push(entry.path()); }
                if dirs.len() >= 512 { break; }
            }
        }
        cursor += 1;
    }
    let git_path = root.join(".git");
    if git_path.is_dir() { dirs.push(git_path.clone()); dirs.push(git_path.join("refs/heads")); }
    else if let Ok(text) = std::fs::read_to_string(&git_path) {
        if let Some(p) = text.trim().strip_prefix("gitdir: ") { dirs.push(root.join(p)); }
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
        if let Ok(event) = event {
            if !matches!(event.kind, notify::EventKind::Access(_)) { let _ = tx.send(()); }
        }
    }).map_err(|e| e.to_string())?;
    for dir in dirs { let _ = watcher.watch(&dir, notify::RecursiveMode::NonRecursive); }
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            loop {
                match rx.recv_timeout(std::time::Duration::from_millis(650)) {
                    Ok(_) => continue,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                    Err(_) => break,
                }
            }
            let _ = app.emit("repository-changed", ());
        }
    });
    *state.watcher.lock().map_err(|_| "监听器不可用")? = Some(watcher);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if let Some(p) = folder_from_args(&argv) { let _ = app.emit("open-path", p); }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { gate: Arc::new(Mutex::new(())), cancel: Arc::new(AtomicU64::new(0)), watcher: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![request, cancel_task, watch_project, initial_path])
        .setup(|app| { let _ = app.path().app_config_dir().map(std::fs::create_dir_all); Ok(()) })
        .run(tauri::generate_context!())
        .expect("无法启动纸笺 Git");
}
