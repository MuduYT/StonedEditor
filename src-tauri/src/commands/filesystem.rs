use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use rfd::FileDialog;
use serde::Serialize;

pub struct ProjectState {
    pub root: Mutex<Option<PathBuf>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeNode {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub expanded: Option<bool>,
    pub language: Option<String>,
    pub has_children: Option<bool>,
    pub is_loaded: Option<bool>,
    pub children: Option<Vec<FileTreeNode>>,
}

#[tauri::command]
pub fn open_project_dir(state: tauri::State<ProjectState>) -> Result<Option<String>, String> {
    let Some(selected) = FileDialog::new().pick_folder() else {
        return Ok(None);
    };

    let root = canonicalize_existing(&selected)?;
    let normalized = normalize_path(&root);
    let mut project_root = state
        .root
        .lock()
        .map_err(|_| "Projektstatus konnte nicht gesperrt werden.".to_string())?;
    *project_root = Some(root);

    Ok(Some(normalized))
}

#[tauri::command]
pub fn read_dir_children(
    path: String,
    state: tauri::State<ProjectState>,
) -> Result<Vec<FileTreeNode>, String> {
    let directory = resolve_project_path(&state, &path)?;

    if !directory.is_dir() {
        return Err(format!("Kein Ordner: {}", directory.display()));
    }

    let mut entries = fs::read_dir(&directory)
        .map_err(|error| format!("Ordner konnte nicht gelesen werden: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| !should_skip(path))
        .collect::<Vec<_>>();

    entries.sort_by(|left, right| {
        right
            .is_dir()
            .cmp(&left.is_dir())
            .then_with(|| display_name(left).to_lowercase().cmp(&display_name(right).to_lowercase()))
    });

    Ok(entries
        .into_iter()
        .map(|path| {
            if path.is_dir() {
                build_directory_stub(&path)
            } else {
                build_file_node(&path)
            }
        })
        .collect())
}

#[tauri::command]
pub fn read_file_content(path: String, state: tauri::State<ProjectState>) -> Result<String, String> {
    let file = resolve_project_path(&state, &path)?;

    if !file.is_file() {
        return Err(format!("Keine Datei: {}", file.display()));
    }

    let bytes = fs::read(&file)
        .map_err(|error| format!("Datei konnte nicht gelesen werden: {error}"))?;

    if bytes.contains(&0) {
        return Err("Binärdateien können nicht im Editor geöffnet werden.".to_string());
    }

    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub fn save_file_content(
    path: String,
    content: String,
    state: tauri::State<ProjectState>,
) -> Result<(), String> {
    let file = resolve_project_path(&state, &path)?;

    if !file.is_file() {
        return Err(format!("Keine Datei: {}", file.display()));
    }

    fs::write(&file, content)
        .map_err(|error| format!("Datei konnte nicht gespeichert werden: {error}"))
}

fn resolve_project_path(state: &tauri::State<ProjectState>, raw_path: &str) -> Result<PathBuf, String> {
    let root = state
        .root
        .lock()
        .map_err(|_| "Projektstatus konnte nicht gesperrt werden.".to_string())?
        .clone()
        .ok_or_else(|| "Kein Projektordner geöffnet.".to_string())?;

    let candidate = PathBuf::from(raw_path);
    let absolute = if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    };
    let canonical = canonicalize_existing(&absolute)?;

    if !canonical.starts_with(&root) {
        return Err("Zugriff außerhalb des geöffneten Projektordners ist nicht erlaubt.".to_string());
    }

    Ok(canonical)
}

fn canonicalize_existing(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|error| format!("Pfad konnte nicht aufgelöst werden ({}): {error}", path.display()))
}

fn build_directory_stub(path: &Path) -> FileTreeNode {
    FileTreeNode {
        id: normalize_path(path),
        name: display_name(path),
        path: normalize_path(path),
        node_type: "directory".to_string(),
        expanded: Some(false),
        language: None,
        has_children: Some(directory_has_visible_children(path)),
        is_loaded: Some(false),
        children: Some(Vec::new()),
    }
}

fn build_file_node(path: &Path) -> FileTreeNode {
    let name = display_name(path);
    FileTreeNode {
        id: normalize_path(path),
        name: name.clone(),
        path: normalize_path(path),
        node_type: "file".to_string(),
        expanded: None,
        language: Some(detect_language(&name)),
        has_children: Some(false),
        is_loaded: Some(true),
        children: None,
    }
}

fn directory_has_visible_children(path: &Path) -> bool {
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .any(|entry| !should_skip(&entry.path()))
}

fn should_skip(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return true;
    };

    if metadata.file_type().is_symlink() {
        return true;
    }

    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };

    matches!(
        name,
        ".git"
            | ".next"
            | ".turbo"
            | ".cache"
            | "node_modules"
            | "dist"
            | "build"
            | "out"
            | "target"
            | "coverage"
            | ".DS_Store"
            | "Thumbs.db"
    )
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(ToString::to_string)
        .unwrap_or_else(|| normalize_path(path))
}

fn normalize_path(path: &Path) -> String {
    let raw = path.to_string_lossy().to_string();
    raw.strip_prefix(r"\\?\").unwrap_or(&raw).replace('\\', "/")
}

fn detect_language(file_name: &str) -> String {
    match file_name.rsplit('.').next().unwrap_or_default().to_lowercase().as_str() {
        "ts" | "tsx" => "typescript",
        "js" | "jsx" => "javascript",
        "json" => "json",
        "css" => "css",
        "html" => "html",
        "md" => "markdown",
        "rs" => "rust",
        "py" => "python",
        "yml" | "yaml" => "yaml",
        "toml" => "toml",
        "sh" => "shell",
        "go" => "go",
        "java" => "java",
        "php" => "php",
        "cs" => "csharp",
        _ => "plaintext",
    }
    .to_string()
}
