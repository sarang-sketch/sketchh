// The window's door to real terminals.
//
// A thin layer on purpose: everything with behaviour in it — finding the shells,
// starting one in a pseudo-terminal, decoding its output, ending it — lives in the
// `sketch-terminal` crate, where `cargo test -p sketch-terminal` exercises it against
// the real shells on the machine. What is HERE is the policy the window must not be
// able to skip:
//
//   * CONSENT. `terminal_open` refuses without `confirmed: true`, like `run_command`.
//     The panel asks once per folder before the first shell starts in it.
//   * CONTAINMENT OF THE STARTING FOLDER. The folder goes through `command_policy`,
//     the one containment implementation in this app. A shell can `cd` anywhere
//     afterwards — it is the user's shell, not a sandbox, as in every IDE.
//   * THE PROGRAM IS NEVER THE WEB VIEW'S CHOICE. The window names a profile id; the
//     program is whatever detection found for that id on this machine.
//
// EVERY COMMAND IS `async`. Tauri runs synchronous commands on the main thread, and a
// terminal command that blocked it would freeze the window — the bug that moved the
// old terminal out of Rust in the first place. Detection, which can run `wsl.exe`,
// goes to the blocking pool.
//
// Output reaches the window through a `tauri::ipc::Channel`, Tauri's ordered stream
// from Rust to one listener: a session's output arrives in order, then one exit.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use sketch_terminal::{
    choose, detect, simplify_path, terminal_env, windows_build_number, EventSink, ShellProfile, SpawnSpec, TerminalEvent,
    TerminalManager,
};
use tauri::ipc::Channel;
use tauri::State;

use crate::command_policy;

/// The app's terminals, and the shells found on this machine (looked up once).
#[derive(Default)]
pub struct TerminalState {
    pub manager: TerminalManager,
    profiles: Mutex<Option<Vec<ShellProfile>>>,
}

impl TerminalState {
    async fn profiles(&self, refresh: bool) -> Result<Vec<ShellProfile>, String> {
        if !refresh {
            if let Some(cached) = self.profiles.lock().map_err(|_| "terminal state is unavailable".to_string())?.clone() {
                return Ok(cached);
            }
        }
        let found = tauri::async_runtime::spawn_blocking(detect)
            .await
            .map_err(|e| format!("could not look for shells: {e}"))?;
        *self.profiles.lock().map_err(|_| "terminal state is unavailable".to_string())? = Some(found.clone());
        Ok(found)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpened {
    id: u32,
    pid: Option<u32>,
    profile: ShellProfile,
    /// The folder the shell started in, as the shell will show it.
    cwd: String,
    /// Set on Windows: the emulator adjusts how it reflows ConPTY output by build.
    windows_build: Option<u32>,
}

/// The shells this machine has, the default first. `refresh` looks again (after the
/// user installs one) instead of answering from what was found at the first ask.
#[tauri::command]
pub async fn terminal_profiles(state: State<'_, TerminalState>, refresh: Option<bool>) -> Result<Vec<ShellProfile>, String> {
    state.profiles(refresh.unwrap_or(false)).await
}

/// Start a shell in a real pseudo-terminal. Output and the exit arrive on `on_event`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn terminal_open(
    state: State<'_, TerminalState>,
    project_root: String,
    cwd: Option<String>,
    profile_id: Option<String>,
    cols: u16,
    rows: u16,
    confirmed: bool,
    on_event: Channel<TerminalEvent>,
) -> Result<TerminalOpened, String> {
    command_policy::require_confirmation(confirmed)?;
    let folder = command_policy::resolve_cwd(&project_root, cwd.as_deref().unwrap_or(""))?;
    let folder = simplify_path(&folder);

    let profiles = state.profiles(false).await?;
    let profile = choose(&profiles, profile_id.as_deref())?.clone();

    let mut env = profile.env.clone();
    env.extend(terminal_env(env!("CARGO_PKG_VERSION")));
    let spec = SpawnSpec {
        program: profile.program.clone(),
        args: profile.args.clone(),
        cwd: folder.clone(),
        env,
        cols,
        rows,
    };
    let channel = Arc::new(on_event);
    let sink: EventSink = Arc::new(move |event| {
        // A window that went away cannot be told; the session ends with the app.
        let _ = channel.send(event);
    });
    let opened = state.manager.open(spec, sink)?;
    Ok(TerminalOpened {
        id: opened.id,
        pid: opened.pid,
        profile,
        cwd: folder.to_string_lossy().into_owned(),
        windows_build: windows_build_number(),
    })
}

/// Keystrokes, a paste, or a whole command line for the shell.
#[tauri::command]
pub async fn terminal_write(state: State<'_, TerminalState>, id: u32, data: String) -> Result<(), String> {
    state.manager.write(id, data.as_bytes())
}

#[tauri::command]
pub async fn terminal_resize(state: State<'_, TerminalState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    state.manager.resize(id, cols, rows)
}

/// End the shell and what it runs, as closing a terminal window does.
#[tauri::command]
pub async fn terminal_close(state: State<'_, TerminalState>, id: u32) -> Result<bool, String> {
    state.manager.close(id)
}
