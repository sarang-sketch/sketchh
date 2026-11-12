//! Real terminal sessions: a shell in a pseudo-terminal, streamed to the window.
//!
//! ── WHY A PSEUDO-TERMINAL ──────────────────────────────────────────────────
//!
//! The terminal panel used to run each typed line as its own process with pipes for
//! stdin and stdout. That covers `npm test`, but nothing that needs a terminal: the
//! arrow-key menus of `npm create vite@latest` and `create-next-app`, a Python or Node
//! REPL, `git add -p`, vim, htop, ssh's password prompt, a virtualenv activated in one
//! line staying active for the next. Every one of those decides what to do by asking
//! "is my stdin a TTY?", and a pipe answers no.
//!
//! A pseudo-terminal answers yes. It is what VS Code, Windows Terminal and iTerm give a
//! shell: ConPTY on Windows 10 1809 and later, openpty on macOS and Linux, through
//! wezterm's `portable-pty`.
//!
//! ── THREADS, NOT THE WINDOW'S ──────────────────────────────────────────────
//!
//! Each session owns three threads: one reads output and hands it to the window, one
//! writes queued input (a slow shell must never block the caller), and one waits for
//! the shell to exit. Nothing here blocks the thread that called it.
//!
//! ── ENDING CLEANLY ON EVERY PLATFORM ───────────────────────────────────────
//!
//! On Unix the reader sees end-of-file when the last holder of the terminal's slave
//! side closes it, which is why the parent drops its copy straight after spawning. On
//! Windows the pseudo console outlives its shell and keeps the output pipe open, so the
//! reader would wait forever; after the shell exits, the pseudo console is closed, which
//! flushes what is left and ends the read. Either way the window gets every byte of
//! output first and one `Exit` last.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

use crate::utf8::Utf8Stream;

/// Terminals open at once, per window process.
pub const DEFAULT_MAX_SESSIONS: usize = 32;
/// One write: a paste, not a file.
pub const MAX_WRITE_BYTES: usize = 1 << 20;
const READ_BUFFER_BYTES: usize = 32 * 1024;

/// What the window hears about a session, in order: output, then exactly one exit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    Data { data: String },
    /// `code` is absent when the exit status could not be read.
    Exit { code: Option<u32> },
}

/// Where a session's events go. The Tauri layer forwards them to the web view.
pub type EventSink = Arc<dyn Fn(TerminalEvent) + Send + Sync>;

/// What to start, already decided and validated by the caller.
#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub id: u32,
    pub pid: Option<u32>,
}

struct Session {
    input: mpsc::Sender<Vec<u8>>,
    /// `None` once closed. Dropping it closes the pseudo console.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    exited: AtomicBool,
}

/// Every open terminal in this process.
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<u32, Arc<Session>>>>,
    next_id: AtomicU32,
    max_sessions: usize,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::with_limit(DEFAULT_MAX_SESSIONS)
    }
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // A panic while holding one of these locks leaves plain data behind; keep going.
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn clamp_size(cols: u16, rows: u16) -> PtySize {
    PtySize { cols: cols.clamp(2, 2000), rows: rows.clamp(1, 1000), pixel_width: 0, pixel_height: 0 }
}

impl TerminalManager {
    pub fn with_limit(max_sessions: usize) -> Self {
        Self { sessions: Arc::new(Mutex::new(HashMap::new())), next_id: AtomicU32::new(0), max_sessions }
    }

    /// Sessions whose shell has not been reaped yet.
    pub fn count(&self) -> usize {
        locked(&self.sessions).len()
    }

    /// Start `spec` in a new pseudo-terminal. Output and the exit arrive at `sink`.
    pub fn open(&self, spec: SpawnSpec, sink: EventSink) -> Result<Opened, String> {
        if self.count() >= self.max_sessions {
            return Err(format!("{} terminals are already open. Close one to open another.", self.max_sessions));
        }

        let pair = native_pty_system()
            .openpty(clamp_size(spec.cols, spec.rows))
            .map_err(|e| format!("could not create a terminal: {e}"))?;

        let mut cmd = CommandBuilder::new(&spec.program);
        cmd.args(&spec.args);
        cmd.cwd(&spec.cwd);
        for (key, value) in &spec.env {
            cmd.env(key, value);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("could not start {}: {e}", display_program(&spec.program)))?;
        // The parent's copy of the slave side must go, or Unix never reports end-of-file.
        drop(pair.slave);

        let pid = child.process_id();
        let killer = child.clone_killer();
        let master = pair.master;
        let reader = match master.try_clone_reader() {
            Ok(reader) => reader,
            Err(e) => {
                let _ = child.kill();
                return Err(format!("could not read from the terminal: {e}"));
            }
        };
        let writer = match master.take_writer() {
            Ok(writer) => writer,
            Err(e) => {
                let _ = child.kill();
                return Err(format!("could not write to the terminal: {e}"));
            }
        };

        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>();
        let session = Arc::new(Session {
            input: input_tx,
            master: Mutex::new(Some(master)),
            killer: Mutex::new(killer),
            exited: AtomicBool::new(false),
        });
        locked(&self.sessions).insert(id, session.clone());

        // Input: queued here, written in order, so a busy shell never blocks a caller.
        let spawned_writer = thread::Builder::new().name(format!("sketch-terminal-{id}-input")).spawn(move || {
            let mut writer = writer;
            for chunk in input_rx {
                if writer.write_all(&chunk).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
        });

        // Output: decoded without splitting characters, forwarded as it arrives.
        let (read_done_tx, read_done_rx) = mpsc::channel::<()>();
        let read_sink = sink.clone();
        let spawned_reader = thread::Builder::new().name(format!("sketch-terminal-{id}-output")).spawn(move || {
            let mut reader = reader;
            let mut decoder = Utf8Stream::new();
            let mut buffer = vec![0u8; READ_BUFFER_BYTES];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        let text = decoder.push(&buffer[..n]);
                        if !text.is_empty() {
                            read_sink(TerminalEvent::Data { data: text });
                        }
                    }
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    // EIO on Linux once the slave side is gone; a broken pipe on Windows.
                    Err(_) => break,
                }
            }
            let rest = decoder.finish();
            if !rest.is_empty() {
                read_sink(TerminalEvent::Data { data: rest });
            }
            let _ = read_done_tx.send(());
        });

        // Exit: reaped, output drained, then one Exit and the session is forgotten.
        let sessions = self.sessions.clone();
        let waited = session.clone();
        let spawned_waiter = thread::Builder::new().name(format!("sketch-terminal-{id}-wait")).spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code());
            waited.exited.store(true, Ordering::SeqCst);
            if cfg!(windows) {
                // Let the pseudo console render the last frame, then close it so the
                // reader reaches the end of the output instead of waiting forever.
                thread::sleep(Duration::from_millis(80));
                locked(&waited.master).take();
            }
            // Normally immediate. Bounded because on Unix a background job started from
            // the shell can keep the terminal open after the shell itself has gone.
            let _ = read_done_rx.recv_timeout(Duration::from_millis(2000));
            sink(TerminalEvent::Exit { code });
            locked(&waited.master).take();
            locked(&sessions).remove(&id);
        });

        if spawned_writer.is_err() || spawned_reader.is_err() || spawned_waiter.is_err() {
            let _ = self.close(id);
            return Err("could not start the terminal's worker threads".to_string());
        }
        Ok(Opened { id, pid })
    }

    fn session(&self, id: u32) -> Result<Arc<Session>, String> {
        locked(&self.sessions)
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("Terminal {id} is not open (its shell may have exited)."))
    }

    /// Type into the terminal: keystrokes, a paste, a command line.
    pub fn write(&self, id: u32, data: &[u8]) -> Result<(), String> {
        if data.len() > MAX_WRITE_BYTES {
            return Err("That is too much text to send to a terminal in one go.".to_string());
        }
        let session = self.session(id)?;
        if session.exited.load(Ordering::SeqCst) {
            return Err("This terminal's shell has exited.".to_string());
        }
        session.input.send(data.to_vec()).map_err(|_| "This terminal is closing.".to_string())
    }

    /// Tell the shell the window is now `cols` × `rows` characters.
    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.session(id)?;
        let master = locked(&session.master);
        match master.as_ref() {
            Some(master) => master.resize(clamp_size(cols, rows)).map_err(|e| format!("could not resize the terminal: {e}")),
            None => Ok(()),
        }
    }

    /// End the shell — as closing a terminal window would — and everything it runs.
    /// Returns false when there was no such terminal.
    pub fn close(&self, id: u32) -> Result<bool, String> {
        let session = match self.session(id) {
            Ok(session) => session,
            Err(_) => return Ok(false),
        };
        if !session.exited.load(Ordering::SeqCst) {
            // TerminateProcess on Windows; SIGHUP on Unix, which a shell passes to its jobs.
            let _ = locked(&session.killer).kill();
        }
        // Closing the pseudo console sends what is still attached to it the console's
        // close event (Windows) or a hang-up (Unix): a dev server started from this shell
        // stops with it instead of holding its port after the tab is gone.
        locked(&session.master).take();
        Ok(true)
    }

    /// End every terminal. For when the app quits.
    pub fn close_all(&self) {
        let ids: Vec<u32> = locked(&self.sessions).keys().copied().collect();
        for id in ids {
            let _ = self.close(id);
        }
    }
}

fn display_program(program: &str) -> String {
    Path::new(program)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| program.to_string())
}

/// The environment every terminal gets on top of the user's own.
pub fn terminal_env(app_version: &str) -> Vec<(String, String)> {
    let mut env = vec![
        // What the emulator in the window implements: 256 colours and 24-bit colour.
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
        // How tools and prompts recognise the terminal they run in.
        ("TERM_PROGRAM".to_string(), "Sketch".to_string()),
        ("TERM_PROGRAM_VERSION".to_string(), app_version.to_string()),
    ];
    // An app started from the Dock gets no locale, and zsh, git and Python then print
    // warnings and mangle every non-ASCII character. Terminal.app sets one; so does this.
    if cfg!(target_os = "macos")
        && std::env::var_os("LANG").is_none()
        && std::env::var_os("LC_ALL").is_none()
        && std::env::var_os("LC_CTYPE").is_none()
    {
        env.push(("LANG".to_string(), "en_US.UTF-8".to_string()));
    }
    env
}

/// The Windows build, e.g. 22631 — `None` elsewhere or when it cannot be read.
///
/// xterm.js needs it to handle ConPTY correctly: ConPTY before build 21376 re-wraps
/// lines itself, so the emulator must not reflow them a second time, and growing the
/// window must pull rows back out of the scrollback as ConPTY expects.
pub fn windows_build_number() -> Option<u32> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_LOCAL_MACHINE;
        use winreg::RegKey;
        let key = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
            .ok()?;
        let build: String = key.get_value("CurrentBuildNumber").ok()?;
        build.trim().parse().ok()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// `\\?\C:\project` → `C:\project`. A canonicalized Windows path carries the verbatim
/// prefix, and shells show it as the folder they are in — cmd.exe refuses it outright
/// ("UNC paths are not supported") and starts in C:\Windows instead.
pub fn simplify_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{Receiver, RecvTimeoutError};
    use std::time::Instant;

    fn collector() -> (EventSink, Receiver<TerminalEvent>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let sink: EventSink = Arc::new(move |event| {
            let _ = locked(&tx).send(event);
        });
        (sink, rx)
    }

    /// What a terminal emulator does with ConPTY's opening question. With its
    /// inherit-cursor mode, the pseudo console starts by asking "where is the cursor?"
    /// (`ESC[6n`) and waits for the answer before the shell's first byte comes through.
    /// xterm.js in the window answers it; these tests are the emulator here.
    fn answer_queries(manager: &TerminalManager, id: u32, data: &str) {
        if data.contains("\u{1b}[6n") {
            let _ = manager.write(id, b"\x1b[1;1R");
        }
    }

    /// Everything received until the exit (or the deadline), with the exit code.
    fn until_exit(manager: &TerminalManager, id: u32, rx: &Receiver<TerminalEvent>, timeout: Duration) -> (String, Option<Option<u32>>) {
        let deadline = Instant::now() + timeout;
        let mut out = String::new();
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(TerminalEvent::Data { data }) => {
                    answer_queries(manager, id, &data);
                    out.push_str(&data);
                }
                Ok(TerminalEvent::Exit { code }) => return (out, Some(code)),
                Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => return (out, None),
            }
        }
    }

    /// Output received until `needle` appears (or the deadline passes).
    fn until_seen(manager: &TerminalManager, id: u32, rx: &Receiver<TerminalEvent>, needle: &str, timeout: Duration) -> String {
        let deadline = Instant::now() + timeout;
        let mut out = String::new();
        while !out.contains(needle) {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(TerminalEvent::Data { data }) => {
                    answer_queries(manager, id, &data);
                    out.push_str(&data);
                }
                Ok(TerminalEvent::Exit { .. }) | Err(_) => break,
            }
        }
        out
    }

    fn here() -> PathBuf {
        simplify_path(&std::env::current_dir().unwrap().canonicalize().unwrap())
    }

    #[cfg(windows)]
    fn one_shot(command: &str) -> SpawnSpec {
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".to_string());
        SpawnSpec { program: comspec, args: vec!["/d".into(), "/c".into(), command.into()], cwd: here(), env: vec![], cols: 100, rows: 30 }
    }

    #[cfg(unix)]
    fn one_shot(command: &str) -> SpawnSpec {
        SpawnSpec { program: "/bin/sh".into(), args: vec!["-c".into(), command.into()], cwd: here(), env: vec![], cols: 100, rows: 30 }
    }

    #[cfg(windows)]
    fn interactive() -> SpawnSpec {
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".to_string());
        SpawnSpec { program: comspec, args: vec!["/d".into(), "/q".into(), "/k".into()], cwd: here(), env: vec![], cols: 100, rows: 30 }
    }

    #[cfg(unix)]
    fn interactive() -> SpawnSpec {
        SpawnSpec { program: "/bin/sh".into(), args: vec![], cwd: here(), env: vec![], cols: 100, rows: 30 }
    }

    const ENTER: &[u8] = if cfg!(windows) { b"\r" } else { b"\n" };

    #[test]
    fn a_command_runs_in_a_real_terminal_and_its_output_and_exit_code_arrive() {
        let manager = TerminalManager::default();
        let (sink, rx) = collector();
        let opened = manager.open(one_shot("echo sketch-pty-ok && exit 7"), sink).unwrap();
        let (out, exit) = until_exit(&manager, opened.id, &rx, Duration::from_secs(20));
        assert!(out.contains("sketch-pty-ok"), "output was {out:?}");
        assert_eq!(exit, Some(Some(7)));
        // Reaped and forgotten once it exited.
        let deadline = Instant::now() + Duration::from_secs(5);
        while manager.count() > 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(manager.count(), 0);
    }

    #[test]
    fn stdin_is_a_tty_which_is_the_whole_point() {
        let manager = TerminalManager::default();
        let (sink, rx) = collector();
        #[cfg(windows)]
        let probe = one_shot("powershell.exe -NoLogo -NoProfile -Command [Console]::IsInputRedirected");
        #[cfg(unix)]
        let probe = one_shot("if [ -t 0 ]; then echo IS-A-TTY; else echo NOT-A-TTY; fi");
        let opened = manager.open(probe, sink).unwrap();
        let (out, exit) = until_exit(&manager, opened.id, &rx, Duration::from_secs(30));
        assert!(exit.is_some(), "the probe never exited; output {out:?}");
        #[cfg(windows)]
        assert!(out.contains("False"), "stdin was redirected: {out:?}");
        #[cfg(unix)]
        assert!(out.contains("IS-A-TTY"), "stdin was not a tty: {out:?}");
    }

    #[test]
    fn typed_input_reaches_an_interactive_shell_that_keeps_its_state() {
        let manager = TerminalManager::default();
        let (sink, rx) = collector();
        let opened = manager.open(interactive(), sink).unwrap();
        // State that survives between lines: the thing a pipe-per-line terminal could not do.
        #[cfg(windows)]
        let (set, show, expect) = ("set SKETCH_PROBE=kept-between-lines", "echo [%SKETCH_PROBE%]", "[kept-between-lines]");
        #[cfg(unix)]
        let (set, show, expect) = ("SKETCH_PROBE=kept-between-lines", "echo \"[$SKETCH_PROBE]\"", "[kept-between-lines]");
        manager.write(opened.id, [set.as_bytes(), ENTER].concat().as_slice()).unwrap();
        manager.write(opened.id, [show.as_bytes(), ENTER].concat().as_slice()).unwrap();
        let out = until_seen(&manager, opened.id, &rx, expect, Duration::from_secs(20));
        assert!(out.contains(expect), "output was {out:?}");
        manager.write(opened.id, [b"exit".as_slice(), ENTER].concat().as_slice()).unwrap();
        let (_, exit) = until_exit(&manager, opened.id, &rx, Duration::from_secs(20));
        assert!(exit.is_some(), "the shell did not exit after `exit`");
    }

    #[test]
    fn the_shell_starts_in_the_requested_folder() {
        let manager = TerminalManager::default();
        let (sink, rx) = collector();
        let mut spec = if cfg!(windows) { one_shot("cd") } else { one_shot("pwd") };
        let folder = here().join("src");
        spec.cwd = folder.clone();
        let opened = manager.open(spec, sink).unwrap();
        let (out, _) = until_exit(&manager, opened.id, &rx, Duration::from_secs(20));
        let name = folder.file_name().unwrap().to_string_lossy().into_owned();
        let parent = folder.parent().unwrap().file_name().unwrap().to_string_lossy().into_owned();
        assert!(out.contains(&format!("{parent}{}{name}", std::path::MAIN_SEPARATOR)), "output was {out:?}");
    }

    #[test]
    fn the_terminal_reports_the_size_it_was_given_and_resizes() {
        let manager = TerminalManager::default();
        let (sink, rx) = collector();
        #[cfg(windows)]
        let mut spec = one_shot("powershell.exe -NoLogo -NoProfile -Command Start-Sleep -Milliseconds 700; 'W=' + [Console]::WindowWidth");
        #[cfg(unix)]
        let mut spec = one_shot("sleep 1; stty size");
        spec.cols = 100;
        spec.rows = 30;
        let opened = manager.open(spec, sink).unwrap();
        manager.resize(opened.id, 123, 31).unwrap();
        let (out, _) = until_exit(&manager, opened.id, &rx, Duration::from_secs(30));
        #[cfg(windows)]
        assert!(out.contains("W=123"), "output was {out:?}");
        #[cfg(unix)]
        assert!(out.contains("31 123"), "output was {out:?}");
    }

    #[test]
    fn closing_a_terminal_ends_its_shell_and_reports_the_exit() {
        let manager = TerminalManager::default();
        let (sink, rx) = collector();
        let opened = manager.open(interactive(), sink).unwrap();
        thread::sleep(Duration::from_millis(300));
        assert!(manager.close(opened.id).unwrap());
        let (_, exit) = until_exit(&manager, opened.id, &rx, Duration::from_secs(15));
        assert!(exit.is_some(), "no exit after close");
        let deadline = Instant::now() + Duration::from_secs(5);
        while manager.count() > 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(manager.count(), 0);
        // Writing to, resizing or closing it again are refusals or no-ops, never panics.
        assert!(manager.write(opened.id, b"x").is_err());
        assert!(manager.resize(opened.id, 80, 24).is_err());
        assert!(!manager.close(opened.id).unwrap());
    }

    #[test]
    fn the_session_limit_is_enforced() {
        let manager = TerminalManager::with_limit(1);
        let (sink, _rx) = collector();
        let first = manager.open(interactive(), sink.clone()).unwrap();
        let refused = manager.open(interactive(), sink).unwrap_err();
        assert!(refused.contains("Close one"), "{refused}");
        manager.close_all();
        let _ = first;
    }

    #[test]
    fn oversized_writes_are_refused() {
        let manager = TerminalManager::default();
        let (sink, _rx) = collector();
        let opened = manager.open(interactive(), sink).unwrap();
        let huge = vec![b'a'; MAX_WRITE_BYTES + 1];
        assert!(manager.write(opened.id, &huge).unwrap_err().contains("too much"));
        manager.close_all();
    }

    /// Every shell detection finds on this machine really starts in a pseudo-terminal,
    /// in the folder it was asked for, and exits when told to. WSL is left out: it can
    /// boot a virtual machine, which is not a unit test's business.
    #[test]
    fn every_detected_shell_starts_in_the_folder_and_exits() {
        let folder = here().join("src");
        let marker = folder.file_name().unwrap().to_string_lossy().into_owned();
        for profile in crate::profiles::detect().into_iter().filter(|p| p.family != "wsl") {
            let manager = TerminalManager::default();
            let (sink, rx) = collector();
            let mut env = profile.env.clone();
            env.extend(terminal_env("test"));
            let spec = SpawnSpec { program: profile.program.clone(), args: profile.args.clone(), cwd: folder.clone(), env, cols: 120, rows: 30 };
            let opened = manager.open(spec, sink).unwrap_or_else(|e| panic!("{} did not start: {e}", profile.id));
            let print_folder: &[u8] = match profile.family.as_str() {
                "cmd" => b"cd\r",
                "powershell" => b"(Get-Location).Path\r",
                _ => b"pwd\r",
            };
            manager.write(opened.id, print_folder).unwrap();
            let seen = until_seen(&manager, opened.id, &rx, &format!("terminal{}{marker}", if profile.family == "cmd" || profile.family == "powershell" { "\\" } else { "/" }), Duration::from_secs(40));
            manager.write(opened.id, b"exit\r").unwrap();
            let (_, exit) = until_exit(&manager, opened.id, &rx, Duration::from_secs(30));
            assert!(
                seen.contains(&marker),
                "{} did not report the folder it started in; output {seen:?}",
                profile.id
            );
            assert!(exit.is_some(), "{} did not exit after `exit`", profile.id);
            println!("{}: started in {}, exited with {:?}", profile.id, folder.display(), exit.unwrap());
        }
    }

    #[test]
    fn events_serialize_as_tagged_camel_case_objects() {
        let data = serde_json::to_value(TerminalEvent::Data { data: "hi".into() }).unwrap();
        assert_eq!(data, serde_json::json!({ "kind": "data", "data": "hi" }));
        let exit = serde_json::to_value(TerminalEvent::Exit { code: Some(0) }).unwrap();
        assert_eq!(exit, serde_json::json!({ "kind": "exit", "code": 0 }));
    }

    #[test]
    fn verbatim_windows_paths_are_simplified_for_shells() {
        assert_eq!(simplify_path(Path::new(r"\\?\C:\work\app")), PathBuf::from(r"C:\work\app"));
        assert_eq!(simplify_path(Path::new(r"\\?\UNC\server\share\app")), PathBuf::from(r"\\server\share\app"));
        assert_eq!(simplify_path(Path::new("/home/dev/app")), PathBuf::from("/home/dev/app"));
    }

    #[test]
    fn the_windows_build_is_known_on_windows_and_absent_elsewhere() {
        let build = windows_build_number();
        if cfg!(windows) {
            // ConPTY itself needs 17763 (Windows 10 1809); anything running these tests has it.
            assert!(build.unwrap_or(0) >= 17763, "build {build:?}");
        } else {
            assert_eq!(build, None);
        }
    }

    #[test]
    fn every_terminal_advertises_colour_and_identifies_itself() {
        let env = terminal_env("1.2.3");
        assert!(env.contains(&("TERM".to_string(), "xterm-256color".to_string())));
        assert!(env.contains(&("TERM_PROGRAM".to_string(), "Sketch".to_string())));
        assert!(env.contains(&("TERM_PROGRAM_VERSION".to_string(), "1.2.3".to_string())));
    }
}
