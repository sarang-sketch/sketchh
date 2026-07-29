// Sketch Desktop — Tauri backend
// IPC commands that bridge the React frontend to the @sketch/engine.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod command_policy;

use serde::{Deserialize, Serialize};
use std::fs;

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
//
// EVERY path that reaches the disk goes through `command_policy` first. These are
// plain `#[tauri::command]` functions, so the `fs.scope` in tauri.conf.json does not
// apply to them — that scope constrains `tauri-plugin-fs` APIs only. Without the
// containment below, the webview could read any file the OS user can read and write
// anywhere it can write, which with an `unsafe-inline` script policy turns any
// injected script into arbitrary file access (Requirement 13.8).
//
// Containment is the SAME code path the terminal tool uses for its working
// directory, generalized rather than copied: two containment checks that can
// disagree is how one of them ends up wrong.

#[tauri::command]
fn read_dir(project_root: String, path: String) -> Result<Vec<FsEntry>, String> {
    let dir = command_policy::resolve_dir_within(&project_root, &path)?;

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
fn read_file(project_root: String, path: String) -> Result<String, String> {
    let file = command_policy::resolve_file_within(&project_root, &path)?;
    // The error names the path the caller asked for, never the resolved one.
    fs::read_to_string(&file).map_err(|e| format!("failed to read '{}': {}", path, e))
}

#[tauri::command]
fn write_file(project_root: String, path: String, content: String) -> Result<(), String> {
    // A file that does not exist yet cannot be canonicalized, so the write target is
    // resolved against its deepest existing ancestor; see `resolve_write_target`.
    let target = command_policy::resolve_write_target(&project_root, &path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create '{}': {}", path, e))?;
    }
    fs::write(&target, &content).map_err(|e| format!("failed to write '{}': {}", path, e))
}

#[tauri::command]
async fn open_project_dialog<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let folder = app.dialog().file().blocking_pick_folder();
    Ok(folder.map(|p| p.to_string()))
}

// ── Git Commands ────────────────────────────────────────────────────────────
//
// Both commands take a `project_root` and BOTH now resolve it through
// `command_policy` before anything is spawned. They previously did not: the string
// went straight to `current_dir`, so the webview could run `git` in any directory
// the OS user can reach, and `git_diff` additionally forwarded a caller-supplied
// `file` into git's own argument vector — where a value starting with `-` is an
// option and `--output=<path>` is a write primitive. See
// `command_policy::resolve_pathspec_within` for the whole shape of that problem
// (Requirement 13.8).
//
// PARSING LIVES IN THE ENGINE, NOT HERE. The porcelain parser below splits on fixed
// offsets and does not understand renames (`R  old -> new`), quoted or non-ASCII
// paths, or a `##` line for a detached HEAD. The authoritative parser is
// packages/core/src/tools/git.ts, which handles those cases and is what the Git
// panel reads through the `SketchClient` seam. This command is kept for the native
// bridge wrapper that names it, deliberately without a second parser to keep in
// step; its shortcomings are the reason the panel does not depend on it.

#[tauri::command]
fn git_status(project_root: String) -> Result<GitStatus, String> {
    // Canonical, existing, a directory, and refused outright when no project is
    // open — the same root every fs command resolves against.
    let repo = command_policy::resolve_root(&project_root)?;

    let output = std::process::Command::new("git")
        .args(["status", "--porcelain", "-b"])
        .current_dir(&repo)
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
    let repo = command_policy::resolve_root(&project_root)?;

    let mut args = vec!["diff".to_string()];
    if let Some(f) = file {
        // A contained path, not an opaque argument. `--` then terminates option
        // parsing, so even a value this resolver admitted cannot become a flag.
        let path = command_policy::resolve_pathspec_within(&project_root, &f)?;
        args.push("--".to_string());
        args.push(path.to_string_lossy().to_string());
    }

    let output = std::process::Command::new("git")
        .args(&args)
        .current_dir(&repo)
        .output()
        .map_err(|e| format!("Git not available: {}", e))?;

    if !output.status.success() {
        // Named, with the reason, rather than an empty diff that reads as "no
        // changes" (Requirement 27.5).
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "git diff failed{}",
            if stderr.is_empty() {
                String::new()
            } else {
                format!(": {}", stderr)
            }
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ── Shell Commands ──────────────────────────────────────────────────────────

/// The terminal tool. A program from an allowlist, an argument VECTOR, a working
/// directory contained in the open project, and an explicit confirmation — no
/// shell anywhere in the path. The policy lives in `command_policy` so it is unit
/// testable without a webview; see that module for why a denylist was removed
/// rather than extended (Requirement 22.6).
#[tauri::command]
fn run_command(
    project_root: String,
    cwd: String,
    program: String,
    args: Vec<String>,
    confirmed: bool,
) -> Result<CommandOutput, String> {
    command_policy::require_confirmation(confirmed)?;

    let executable = command_policy::resolve_program(&program)?;
    command_policy::check_args(&args)?;
    let working_dir = command_policy::resolve_cwd(&project_root, &cwd)?;

    // No shell: metacharacters in `args` reach the child as literal bytes.
    let output = std::process::Command::new(&executable)
        .args(&args)
        .current_dir(&working_dir)
        .output()
        .map_err(|e| format!("failed to start '{}': {}", executable, e))?;

    Ok(CommandOutput {
        exit_code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

/// What the terminal UI may offer. Exposed so a panel does not hardcode its own
/// copy of the list and drift from what the backend actually permits.
#[tauri::command]
fn allowed_programs() -> Vec<String> {
    command_policy::ALLOWED_PROGRAMS
        .iter()
        .map(|p| (*p).to_string())
        .collect()
}

// ── Main ────────────────────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_dir,
            read_file,
            write_file,
            open_project_dialog,
            git_status,
            git_diff,
            run_command,
            allowed_programs,
        ])
        .run(tauri::generate_context!())
        .expect("error running Sketch");
}
