mod commands;

use commands::{
    open_project_dir, read_dir_children, read_file_content, save_file_content, ProjectState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ProjectState {
            root: std::sync::Mutex::new(None),
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            open_project_dir,
            read_dir_children,
            read_file_content,
            save_file_content
        ])
        .run(tauri::generate_context!())
        .expect("error while running StonedEditor");
}
