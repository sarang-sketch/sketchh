// Sketch Desktop — Tauri backend
// IPC commands that bridge the React frontend to the @sketch/engine.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod command_policy;
mod os_credentials;
mod secret_store;
mod terminal_ipc;

use serde::{Deserialize, Serialize};
use std::fs;

// ── THE WIRE SHAPE IS camelCase, AND IT IS TESTED ───────────────────────────
//
// Tauri converts command ARGUMENTS from camelCase to snake_case for you. It does
// nothing at all to the RETURN value: that is plain serde, so a `snake_case` field
// crosses the IPC boundary as `snake_case` and the TypeScript wrapper reading
// `camelCase` gets `undefined`.
//
// `FsEntry.is_dir` was exactly that bug in the shipped app: `bridge.ts` declares
// `isDir`, so every entry read as a file and the Explorer's folder/file distinction
// was silently broken while the tests — which build entries at the TypeScript seam,
// in the intended shape — stayed green. `CommandOutput.exit_code` had the same
// defect: a non-zero exit would have rendered as "Exited with code undefined".
//
// A test now compares these serialized names against the interfaces in
// src/ipc/bridge.ts (src/ipc/wireShape.test.ts), so the two sides cannot drift
// again without something failing.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FsEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandOutput {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

/// What `list_providers` answers with: an id, whether a key exists, and the name of
/// the store it would be in. THERE IS NO FIELD FOR A KEY, and that is the point —
/// this struct is the entire vocabulary the webview has for a stored secret.
///
/// `camelCase` on the wire because that is what the TypeScript wrapper declares
/// (src/ipc/bridge.ts). Serde's default would send `has_key` while the frontend read
/// `hasKey`, and an always-`undefined` boolean would read on screen as "no key
/// stored" for a provider that has one.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderKeyPresence {
    id: String,
    has_key: bool,
    /// e.g. "Windows Credential Manager". For a UI that says where the key went.
    store: String,
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

// ── Git: the engine owns it, not this bridge (B-010) ─────────────────────────
//
// There are no `git_status` / `git_diff` native commands here any more. Git for the
// IDE goes through the engine over the `SketchClient` RPC seam
// (`packages/core/src/tools/git.ts`), which is the ONE git parser in the project —
// it understands renames (`R  old -> new`), C-quoted and non-ASCII paths, detached
// HEAD, "no commits yet", and a non-zero exit code, none of which the old fixed-offset
// Rust porcelain parser did. The Git panel, the status bar, the diff view and the
// editor's change markers all read the engine; nothing in the webview ever called the
// Rust pair (verified: `ipc/bridge.ts` only DEFINED the wrappers, no caller imported
// them). Keeping a second, weaker parser that nothing used was a standing "two sources
// of truth" hazard (BUG_AUDIT B-010) and a webview-reachable path that spawned `git`,
// so both commands, their bridge wrappers, and the `GitStatus` wire struct are gone.
// `command_policy.rs` is unchanged.

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

// ── Secrets ─────────────────────────────────────────────────────────────────
//
// The three commands the settings surface needs, and NOT A FOURTH. Real storage is
// the operating system's credential store, reached through `os_credentials`; the
// policy — what a legal provider id is, what a plausible key is, what an error may
// say — is in `secret_store`, which is std-only and unit tested standalone
// (Requirement 17.3).
//
// ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────
//
// THERE IS NO COMMAND THAT RETURNS A KEY. Not the value, not a prefix, not a length.
// `list_providers` answers with an id and a bool, because that is all the UI needs to
// decide between "Save key" and "Remove key". A four-character prefix is four
// characters of a secret, and once a value reaches the webview it is one accidental
// `console.log`, one error boundary, and one crash report away from being somewhere
// permanent.
//
// NO KEY IS HELD IN APPLICATION STATE either. These commands are stateless: each one
// builds a backend, performs one operation, and drops everything. There is no
// `AppState` field, no cache, no `Mutex<HashMap<String, String>>`.
//
// NO PATH IS TAKEN by any of them, which is why none of them calls `command_policy`.
// Containment exists for arguments that address the filesystem; a provider id
// addresses a credential record. `secret_store::validate_id` is the door here, and it
// refuses separators and NUL bytes outright. If one of these ever grows a path
// argument, it goes through `command_policy::resolve_within` like everything else —
// there is exactly one containment implementation in this project and it stays that
// way.
//
// ── THE ONE EXCEPTION, AND WHY IT IS ONE ────────────────────────────────────
//
// `resolve_api_key` DOES return a value, because Requirement 17.4 says a key is
// supplied to the engine at invocation time and a store nothing can read from is a
// store that makes the app unusable: before it existed, the only key that could reach
// a model was one the user typed again for that call. It is the single-use resolve
// option recorded here previously, chosen over moving the sidecar spawn into Rust
// because that is a transport rewrite and the webview already carries a typed key
// along the identical path. The narrowing — one validated id per call, stateless, no
// enumeration, `None` for absent — is on the function itself.

/// Whether each named provider has a key in the OS credential store.
///
/// The argument is the provider ids the settings surface is displaying — it is not a
/// listing of the credential store, because enumerating a user's whole keychain is
/// not something this app needs to be able to do.
#[tauri::command]
fn list_providers(provider_ids: Vec<String>) -> Result<Vec<ProviderKeyPresence>, String> {
    let backend = os_credentials::backend();
    let store = backend.describe();
    secret_store::list_presence(backend.as_ref(), &provider_ids)
        .map(|rows| {
            rows.into_iter()
                .map(|row| ProviderKeyPresence {
                    id: row.id,
                    has_key: row.has_key,
                    store: store.clone(),
                })
                .collect()
        })
        .map_err(|e| e.to_string())
}

/// Store one provider's key in the OS credential store. Returns where it went — the
/// NAME of the store, so the UI can be specific — and nothing about the key itself.
#[tauri::command]
fn set_api_key(provider_id: String, api_key: String) -> Result<String, String> {
    let backend = os_credentials::backend();
    secret_store::set_secret(backend.as_ref(), &provider_id, &api_key)
        .map(|()| backend.describe())
        // `SecretError` has no variant that can hold a value, so this cannot echo the
        // key even by accident. See secret_store.rs.
        .map_err(|e| e.to_string())
}

/// Resolve ONE provider's stored key so a run can use it, or `None` when none is stored.
///
/// THIS IS THE ONE COMMAND THAT RETURNS A SECRET VALUE, and it is the invocation-time
/// half of Requirement 17.4. Without it a stored key was unusable: the only key that
/// could reach a model was one the user typed again for that call.
///
/// The narrowing is the point. One id per call, `validate_id`'d like every other secret
/// command, so nothing here can enumerate a keychain. Stateless, so no key is held in
/// application state. `None` for absent, so a caller cannot confuse "no key" with "store
/// broken". The caller must hand the value straight to the run and register it with the
/// engine's redactor — see `resolveApiKey` in the desktop `secrets` module, which is the
/// only caller and never puts the value in React state.
///
/// The better end state remains spawning the sidecar from Rust so the value never
/// enters the webview at all. That is a transport rewrite; this is the honest interim,
/// and the webview already carries a typed key along the same path today.
#[tauri::command]
fn resolve_api_key(provider_id: String) -> Result<Option<String>, String> {
    let backend = os_credentials::backend();
    secret_store::resolve_secret(backend.as_ref(), &provider_id).map_err(|e| e.to_string())
}

/// Remove one provider's key. Removing a key that is not there succeeds: the caller
/// asked for it to be gone.
#[tauri::command]
fn remove_api_key(provider_id: String) -> Result<String, String> {
    let backend = os_credentials::backend();
    secret_store::remove_secret(backend.as_ref(), &provider_id)
        .map(|()| backend.describe())
        .map_err(|e| e.to_string())
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
    use tauri::Manager;
    use tauri_plugin_window_state::StateFlags;

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        // The window opens where it was closed: same size, same place, same monitor,
        // maximized if it was. Decorations and visibility are left to tauri.conf.json —
        // this window draws its own title bar and must never come back with the OS one.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::FULLSCREEN)
                .build(),
        )
        .manage(terminal_ipc::TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            read_dir,
            read_file,
            write_file,
            open_project_dialog,
            run_command,
            allowed_programs,
            list_providers,
            set_api_key,
            resolve_api_key,
            remove_api_key,
            terminal_ipc::terminal_profiles,
            terminal_ipc::terminal_open,
            terminal_ipc::terminal_write,
            terminal_ipc::terminal_resize,
            terminal_ipc::terminal_close,
        ])
        .build(tauri::generate_context!())
        .expect("error building Sketch");

    app.run(|handle, event| {
        // Quitting ends every shell the terminal started, and what those shells run: a
        // dev server must not keep its port after the IDE that started it has gone.
        if let tauri::RunEvent::Exit = event {
            handle.state::<terminal_ipc::TerminalState>().manager.close_all();
        }
    });
}
