// Sketch Desktop — Tauri backend
// IPC commands that bridge the React frontend to the @sketch/engine.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize)]
struct FsEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize, Deserialize)]
struct GitStatus {
    branch: String,
    staged: Vec<String>,
    modified: Vec<String>,
    untracked: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct CommandOutput {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

// ── File System Commands ────────────────────────────────────────────────────

#[tauri::command]
fn read_dir(path: String) -> Result<Vec<FsEntry>, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut entries = Vec::new();
    let read = fs::read_dir(&dir).map_err(|e| e.to_string())?;

    for entry in read {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files and common build artifacts
        if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist" {
            continue;
        }

        entries.push(FsEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = PathBuf::from(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, &content).map_err(|e| format!("Failed to write {}: {}", path, e))
}

#[tauri::command]
fn open_project_dialog(window: tauri::Window) -> Result<Option<String>, String> {
    // In production, use tauri dialog plugin. For now, return None.
    let _ = window;
    Ok(None)
}

// ── Git Commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn git_status(project_root: String) -> Result<GitStatus, String> {
    let output = std::process::Command::new("git")
        .args(["status", "--porcelain", "-b"])
        .current_dir(&project_root)
        .output()
        .map_err(|e| format!("Git not available: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut branch = String::from("unknown");
    let mut staged = Vec::new();
    let mut modified = Vec::new();
    let mut untracked = Vec::new();

    for line in stdout.lines() {
        if line.starts_with("## ") {
            branch = line[3..].split("...").next().unwrap_or("unknown").to_string();
        } else if line.len() >= 3 {
            let x = line.chars().nth(0).unwrap_or(' ');
            let y = line.chars().nth(1).unwrap_or(' ');
            let file = line[3..].to_string();
            if x == '?' {
                untracked.push(file);
            } else {
                if x != ' ' { staged.push(file.clone()); }
                if y != ' ' { modified.push(file); }
            }
        }
    }

    Ok(GitStatus { branch, staged, modified, untracked })
}

#[tauri::command]
fn git_diff(project_root: String, file: Option<String>) -> Result<String, String> {
    let mut args = vec!["diff".to_string()];
    if let Some(f) = file {
        args.push(f);
    }

    let output = std::process::Command::new("git")
        .args(&args)
        .current_dir(&project_root)
        .output()
        .map_err(|e| e.to_string())?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ── Shell Commands ──────────────────────────────────────────────────────────

#[tauri::command]
fn run_command(cwd: String, command: String) -> Result<CommandOutput, String> {
    let output = if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/C", &command])
            .current_dir(&cwd)
            .output()
    } else {
        std::process::Command::new("sh")
            .args(["-c", &command])
            .current_dir(&cwd)
            .output()
    };

    let output = output.map_err(|e| e.to_string())?;

    Ok(CommandOutput {
        exit_code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

// ── Main ────────────────────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            read_dir,
            read_file,
            write_file,
            open_project_dialog,
            git_status,
            git_diff,
            run_command,
        ])
        .run(tauri::generate_context!())
        .expect("error running Sketch");
}
