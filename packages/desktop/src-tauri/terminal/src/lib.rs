//! Sketch's integrated terminal: real pseudo-terminal sessions and the list of shells
//! installed on this machine.
//!
//! Kept free of Tauri on purpose. The desktop app's `terminal_ipc` module is a thin
//! layer that forwards window requests here, so everything with behaviour in it —
//! detection, decoding, the session lifecycle — is unit tested with plain `cargo test
//! -p sketch-terminal`, against real shells, without building the app.

pub mod profiles;
pub mod session;
pub mod utf8;

pub use profiles::{choose, detect, ShellProfile};
pub use session::{
    simplify_path, terminal_env, windows_build_number, EventSink, Opened, SpawnSpec, TerminalEvent, TerminalManager,
};
