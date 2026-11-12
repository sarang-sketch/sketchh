//! Which shells this machine has, as the terminal's "new terminal" menu lists them.
//!
//! An IDE that only ever starts one shell fails real people: the Cursor forum's
//! longest-running Windows threads are about an agent terminal hardcoded to
//! PowerShell — slow to start, or blocked outright by an execution policy — while the
//! user's own work happens in Git Bash, WSL or Nushell. So detection looks for every
//! shell a developer is likely to have, in the places their installers put them, and
//! the user picks.
//!
//! Detection is a pure function of a [`Machine`] — environment, file existence, the
//! WSL distribution list — so the tests can describe any computer, and the real one is
//! one implementation of it ([`detect`]).
//!
//! THE PROGRAM IS NEVER TAKEN FROM THE WEB VIEW. The window asks for a profile by `id`;
//! the backend re-runs detection and starts the program detection found. A script in
//! the web view can choose among the user's shells, never name an arbitrary binary.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// One shell the terminal can start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    /// Stable across launches, so a remembered default keeps meaning the same shell.
    pub id: String,
    /// What the menu shows: "PowerShell", "Git Bash", "Ubuntu (WSL)".
    pub name: String,
    /// Absolute path of the program.
    pub program: String,
    pub args: Vec<String>,
    /// The shell family, for the menu's icon: powershell, cmd, bash, zsh, fish, nu, wsl, sh.
    pub family: String,
    /// Environment set for this shell only (MSYS2's subsystem, "stay in this folder").
    #[serde(skip)]
    pub env: Vec<(String, String)>,
}

/// Everything detection may look at.
pub struct Machine<'a> {
    pub env: &'a dyn Fn(&str) -> Option<String>,
    pub exists: &'a dyn Fn(&Path) -> bool,
    /// The distributions `wsl.exe --list --quiet` reports, given the path to wsl.exe.
    pub wsl_distros: &'a dyn Fn(&Path) -> Vec<String>,
    /// The contents of /etc/shells, where the system keeps its list of login shells.
    pub etc_shells: &'a dyn Fn() -> Option<String>,
}

fn profile(id: &str, name: &str, program: &Path, args: &[&str], family: &str) -> ShellProfile {
    ShellProfile {
        id: id.to_string(),
        name: name.to_string(),
        program: program.to_string_lossy().into_owned(),
        args: args.iter().map(|a| (*a).to_string()).collect(),
        family: family.to_string(),
        env: Vec::new(),
    }
}

fn with_env(mut p: ShellProfile, env: &[(&str, &str)]) -> ShellProfile {
    p.env = env.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect();
    p
}

/// `PATH`'s entries. Windows' separator is `;` whatever platform the tests run on.
fn windows_path_dirs(m: &Machine) -> Vec<PathBuf> {
    (m.env)("PATH")
        .or_else(|| (m.env)("Path"))
        .unwrap_or_default()
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| PathBuf::from(entry.trim_matches('"')))
        .collect()
}

fn on_windows_path(m: &Machine, exe: &str) -> Option<PathBuf> {
    windows_path_dirs(m)
        .into_iter()
        .map(|dir| dir.join(exe))
        .find(|candidate| (m.exists)(candidate))
}

fn first_existing(m: &Machine, candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|candidate| (m.exists)(candidate))
}

/// Docker Desktop's two internal distributions are not shells anyone means to open.
fn is_interactive_distro(name: &str) -> bool {
    !name.eq_ignore_ascii_case("docker-desktop") && !name.eq_ignore_ascii_case("docker-desktop-data")
}

/// The shells on a Windows machine, the most likely default first.
pub fn detect_windows(m: &Machine) -> Vec<ShellProfile> {
    let env = |name: &str| (m.env)(name).filter(|value| !value.trim().is_empty());
    let program_files = PathBuf::from(env("ProgramFiles").unwrap_or_else(|| "C:\\Program Files".to_string()));
    let program_files_x86 = env("ProgramFiles(x86)").map(PathBuf::from);
    let local_app_data = env("LOCALAPPDATA").map(PathBuf::from);
    let user_profile = env("USERPROFILE").map(PathBuf::from);
    let system_root = PathBuf::from(env("SystemRoot").or_else(|| env("windir")).unwrap_or_else(|| "C:\\Windows".to_string()));
    let system32 = system_root.join("System32");
    let system_drive = PathBuf::from(format!("{}\\", env("SystemDrive").unwrap_or_else(|| "C:".to_string())));

    let mut out = Vec::new();

    // PowerShell 7+, from the MSI, winget, Scoop or the Microsoft Store (an app
    // execution alias in WindowsApps, which is why existence is checked without
    // following reparse points).
    let mut pwsh_candidates = vec![program_files.join("PowerShell").join("7").join("pwsh.exe")];
    pwsh_candidates.extend(on_windows_path(m, "pwsh.exe"));
    if let Some(local) = &local_app_data {
        pwsh_candidates.push(local.join("Microsoft").join("WindowsApps").join("pwsh.exe"));
    }
    if let Some(pwsh) = first_existing(m, pwsh_candidates) {
        out.push(profile("pwsh", "PowerShell", &pwsh, &["-NoLogo"], "powershell"));
    }

    // Windows PowerShell 5.1 is on every Windows 10 and 11 machine. Its default
    // execution policy is Restricted, which refuses npm.ps1, a virtualenv's
    // Activate.ps1 and every profile script — the single most common "my terminal is
    // broken" question about IDE terminals on Windows. Process scope only: a policy set
    // by Group Policy still wins over the command line.
    let windows_powershell = system32.join("WindowsPowerShell").join("v1.0").join("powershell.exe");
    if (m.exists)(&windows_powershell) {
        out.push(profile(
            "powershell",
            "Windows PowerShell",
            &windows_powershell,
            &["-NoLogo", "-ExecutionPolicy", "Bypass"],
            "powershell",
        ));
    }

    let cmd = env("ComSpec").map(PathBuf::from).filter(|p| (m.exists)(p)).unwrap_or_else(|| system32.join("cmd.exe"));
    if (m.exists)(&cmd) {
        out.push(profile("cmd", "Command Prompt", &cmd, &[], "cmd"));
    }

    // Git Bash: Git for Windows puts git.exe in <Git>\cmd and bash in <Git>\bin, so a
    // git on PATH also finds a Git installed somewhere unusual.
    let mut git_candidates = vec![program_files.join("Git").join("bin").join("bash.exe")];
    if let Some(x86) = &program_files_x86 {
        git_candidates.push(x86.join("Git").join("bin").join("bash.exe"));
    }
    if let Some(local) = &local_app_data {
        git_candidates.push(local.join("Programs").join("Git").join("bin").join("bash.exe"));
    }
    if let Some(home) = &user_profile {
        git_candidates.push(home.join("scoop").join("apps").join("git").join("current").join("bin").join("bash.exe"));
    }
    if let Some(git) = on_windows_path(m, "git.exe") {
        if let Some(root) = git.parent().and_then(Path::parent) {
            git_candidates.push(root.join("bin").join("bash.exe"));
        }
    }
    if let Some(bash) = first_existing(m, git_candidates) {
        out.push(with_env(
            profile("git-bash", "Git Bash", &bash, &["--login", "-i"], "bash"),
            &[("CHERE_INVOKING", "1")],
        ));
    }

    // WSL: one entry per installed distribution. A machine with only the wsl.exe stub
    // reports none, so it gets no entry rather than one that cannot start.
    let wsl = system32.join("wsl.exe");
    if (m.exists)(&wsl) {
        for distro in (m.wsl_distros)(&wsl) {
            let distro = distro.trim();
            if distro.is_empty() || !is_interactive_distro(distro) {
                continue;
            }
            out.push(profile(
                &format!("wsl:{distro}"),
                &format!("{distro} (WSL)"),
                &wsl,
                &["-d", distro],
                "wsl",
            ));
        }
    }

    // MSYS2's recommended environment, with the Windows PATH kept so node, python and
    // git installed for Windows still work inside it.
    let msys2 = system_drive.join("msys64").join("usr").join("bin").join("bash.exe");
    if (m.exists)(&msys2) {
        out.push(with_env(
            profile("msys2", "MSYS2 (UCRT64)", &msys2, &["--login", "-i"], "bash"),
            &[("MSYSTEM", "UCRT64"), ("CHERE_INVOKING", "1"), ("MSYS2_PATH_TYPE", "inherit")],
        ));
    }

    let cygwin = system_drive.join("cygwin64").join("bin").join("bash.exe");
    if (m.exists)(&cygwin) {
        out.push(with_env(
            profile("cygwin", "Cygwin", &cygwin, &["--login", "-i"], "bash"),
            &[("CHERE_INVOKING", "1")],
        ));
    }

    let nu = on_windows_path(m, "nu.exe").or_else(|| first_existing(m, [program_files.join("nu").join("bin").join("nu.exe")]));
    if let Some(nu) = nu {
        out.push(profile("nu", "Nushell", &nu, &[], "nu"));
    }

    out
}

/// Interactive shells worth offering; /etc/shells also lists things like git-shell.
const UNIX_SHELLS: &[&str] = &["zsh", "bash", "fish", "nu", "pwsh", "sh", "dash", "ksh", "tcsh", "csh", "elvish", "xonsh"];

fn unix_profile(path: &Path) -> Option<ShellProfile> {
    let base = path.file_name()?.to_string_lossy().into_owned();
    if !UNIX_SHELLS.contains(&base.as_str()) {
        return None;
    }
    let (name, args, family): (&str, &[&str], &str) = match base.as_str() {
        // A login shell reads ~/.zprofile / ~/.bash_profile, which is where Homebrew,
        // nvm and pyenv put themselves on PATH. A desktop app started from the Dock or
        // a launcher inherits a bare PATH, so without -l `npm` is "command not found".
        "zsh" => ("zsh", &["-l"], "zsh"),
        "bash" => ("bash", &["-l"], "bash"),
        "fish" => ("fish", &["-l"], "fish"),
        "nu" => ("Nushell", &["-l"], "nu"),
        // -Login must be the first argument to pwsh on macOS and Linux.
        "pwsh" => ("PowerShell", &["-Login", "-NoLogo"], "powershell"),
        other => (other, &[], "sh"),
    };
    Some(profile(&base, name, path, args, family))
}

/// The shells on a macOS or Linux machine: the user's own `$SHELL` first.
pub fn detect_unix(m: &Machine) -> Vec<ShellProfile> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut add = |candidate: &str| {
        let path = Path::new(candidate.trim());
        // `has_root`, not `is_absolute`: the same check on Unix, and it lets this logic
        // be exercised by tests on a Windows machine, where "/bin/bash" has no drive.
        if !path.has_root() || !(m.exists)(path) {
            return;
        }
        if let Some(p) = unix_profile(path) {
            if seen.insert(p.id.clone()) {
                out.push(p);
            }
        }
    };

    if let Some(shell) = (m.env)("SHELL") {
        add(&shell);
    }
    if let Some(listed) = (m.etc_shells)() {
        for line in listed.lines() {
            let line = line.trim();
            if !line.is_empty() && !line.starts_with('#') {
                add(line);
            }
        }
    }
    for candidate in [
        "/bin/zsh",
        "/usr/bin/zsh",
        "/opt/homebrew/bin/zsh",
        "/bin/bash",
        "/usr/bin/bash",
        "/opt/homebrew/bin/bash",
        "/usr/local/bin/bash",
        "/usr/bin/fish",
        "/usr/local/bin/fish",
        "/opt/homebrew/bin/fish",
        "/usr/bin/nu",
        "/usr/local/bin/nu",
        "/opt/homebrew/bin/nu",
        "/usr/bin/pwsh",
        "/usr/local/bin/pwsh",
        "/opt/homebrew/bin/pwsh",
        "/bin/sh",
    ] {
        add(candidate);
    }
    out
}

/// `wsl.exe --list --quiet` writes UTF-16LE unless WSL_UTF8=1 is set. Either way: one
/// distribution per line.
pub fn parse_wsl_list(bytes: &[u8]) -> Vec<String> {
    let looks_utf16 = bytes.starts_with(&[0xFF, 0xFE])
        || (bytes.len() >= 2 && bytes.iter().skip(1).step_by(2).take(32).all(|b| *b == 0));
    let text = if looks_utf16 {
        let units: Vec<u16> = bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    text.trim_start_matches('\u{FEFF}')
        .lines()
        .map(|line| line.replace('\0', "").trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

#[cfg(windows)]
fn real_wsl_distros(wsl: &Path) -> Vec<String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    // No console window flashing up behind the IDE.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let child = Command::new(wsl)
        .args(["--list", "--quiet"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    let Ok(mut child) = child else { return Vec::new() };
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Vec::new();
                }
                break;
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Vec::new();
            }
        }
    }
    let mut bytes = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        use std::io::Read;
        let _ = stdout.read_to_end(&mut bytes);
    }
    parse_wsl_list(&bytes)
}

#[cfg(not(windows))]
fn real_wsl_distros(_wsl: &Path) -> Vec<String> {
    Vec::new()
}

/// The shells on THIS machine.
pub fn detect() -> Vec<ShellProfile> {
    let env = |name: &str| std::env::var(name).ok();
    // symlink_metadata: a Store app's execution alias is a reparse point that
    // `Path::exists` (which follows it) can report as missing.
    let exists = |path: &Path| std::fs::symlink_metadata(path).is_ok();
    let etc_shells = || std::fs::read_to_string("/etc/shells").ok();
    let machine = Machine { env: &env, exists: &exists, wsl_distros: &real_wsl_distros, etc_shells: &etc_shells };
    if cfg!(windows) {
        detect_windows(&machine)
    } else {
        detect_unix(&machine)
    }
}

/// The profile `id` names, or the machine's default (the first) when `id` is absent.
pub fn choose<'a>(profiles: &'a [ShellProfile], id: Option<&str>) -> Result<&'a ShellProfile, String> {
    match id.filter(|id| !id.trim().is_empty()) {
        Some(id) => profiles
            .iter()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("The shell \"{id}\" is not installed on this computer (any more).")),
        None => profiles
            .first()
            .ok_or_else(|| "No shell was found on this computer to start a terminal with.".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    struct FakeMachine {
        env: HashMap<&'static str, String>,
        files: HashSet<PathBuf>,
        distros: Vec<String>,
        etc_shells: Option<String>,
    }

    impl FakeMachine {
        fn windows() -> Self {
            let mut env = HashMap::new();
            env.insert("ProgramFiles", "C:\\Program Files".to_string());
            env.insert("ProgramFiles(x86)", "C:\\Program Files (x86)".to_string());
            env.insert("LOCALAPPDATA", "C:\\Users\\dev\\AppData\\Local".to_string());
            env.insert("USERPROFILE", "C:\\Users\\dev".to_string());
            env.insert("SystemRoot", "C:\\Windows".to_string());
            env.insert("SystemDrive", "C:".to_string());
            env.insert("ComSpec", "C:\\Windows\\system32\\cmd.exe".to_string());
            FakeMachine { env, files: HashSet::new(), distros: Vec::new(), etc_shells: None }
        }

        fn file(mut self, path: &str) -> Self {
            self.files.insert(Self::path(path));
            self
        }

        /// The tests run on any platform; a Windows path is split on `\` here so that
        /// `Path::join` builds the same key detection will look up.
        fn path(path: &str) -> PathBuf {
            let mut parts = path.split('\\');
            let mut out = PathBuf::from(format!("{}\\", parts.next().unwrap()));
            for part in parts {
                out = out.join(part);
            }
            out
        }

        fn detect_windows(&self) -> Vec<ShellProfile> {
            let env = |name: &str| self.env.get(name).cloned();
            let exists = |path: &Path| self.files.contains(path);
            let distros = |_: &Path| self.distros.clone();
            let etc = || self.etc_shells.clone();
            detect_windows(&Machine { env: &env, exists: &exists, wsl_distros: &distros, etc_shells: &etc })
        }

        fn detect_unix(&self) -> Vec<ShellProfile> {
            let env = |name: &str| self.env.get(name).cloned();
            let exists = |path: &Path| self.files.contains(path);
            let distros = |_: &Path| self.distros.clone();
            let etc = || self.etc_shells.clone();
            detect_unix(&Machine { env: &env, exists: &exists, wsl_distros: &distros, etc_shells: &etc })
        }
    }

    fn ids(profiles: &[ShellProfile]) -> Vec<&str> {
        profiles.iter().map(|p| p.id.as_str()).collect()
    }

    // Windows paths only compare component-by-component on Windows, so the Windows
    // detection tests run there; the Unix detection test runs everywhere.
    #[cfg(windows)]
    #[test]
    fn a_stock_windows_machine_offers_windows_powershell_first_then_cmd() {
        let machine = FakeMachine::windows()
            .file("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
            .file("C:\\Windows\\system32\\cmd.exe");
        let found = machine.detect_windows();
        assert_eq!(ids(&found), vec!["powershell", "cmd"]);
        // Restricted is Windows PowerShell's default policy; npm.ps1 must still run.
        assert!(found[0].args.windows(2).any(|w| w == ["-ExecutionPolicy", "Bypass"]));
        assert_eq!(found[1].name, "Command Prompt");
    }

    #[cfg(windows)]
    #[test]
    fn powershell_7_git_bash_wsl_msys2_cygwin_and_nushell_are_all_found() {
        let mut machine = FakeMachine::windows()
            .file("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
            .file("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
            .file("C:\\Windows\\system32\\cmd.exe")
            .file("C:\\Program Files\\Git\\bin\\bash.exe")
            .file("C:\\Windows\\System32\\wsl.exe")
            .file("C:\\msys64\\usr\\bin\\bash.exe")
            .file("C:\\cygwin64\\bin\\bash.exe")
            .file("C:\\Tools\\nu\\nu.exe");
        machine.env.insert("PATH", "C:\\Windows\\system32;C:\\Tools\\nu".to_string());
        machine.distros = vec!["Ubuntu-24.04".to_string(), "docker-desktop".to_string(), "Debian".to_string()];
        let found = machine.detect_windows();
        assert_eq!(
            ids(&found),
            vec!["pwsh", "powershell", "cmd", "git-bash", "wsl:Ubuntu-24.04", "wsl:Debian", "msys2", "cygwin", "nu"]
        );
        let wsl = found.iter().find(|p| p.id == "wsl:Debian").unwrap();
        assert_eq!(wsl.args, vec!["-d", "Debian"]);
        assert_eq!(wsl.name, "Debian (WSL)");
        let git_bash = found.iter().find(|p| p.id == "git-bash").unwrap();
        assert!(git_bash.env.contains(&("CHERE_INVOKING".to_string(), "1".to_string())));
        let msys2 = found.iter().find(|p| p.id == "msys2").unwrap();
        assert!(msys2.env.contains(&("MSYSTEM".to_string(), "UCRT64".to_string())));
    }

    #[cfg(windows)]
    #[test]
    fn git_bash_is_found_through_a_git_on_path_in_an_unusual_folder() {
        let mut machine = FakeMachine::windows()
            .file("D:\\DevTools\\Git\\cmd\\git.exe")
            .file("D:\\DevTools\\Git\\bin\\bash.exe");
        machine.env.insert("PATH", "D:\\DevTools\\Git\\cmd".to_string());
        let found = machine.detect_windows();
        let bash = found.iter().find(|p| p.id == "git-bash").expect("Git Bash");
        assert_eq!(PathBuf::from(&bash.program), FakeMachine::path("D:\\DevTools\\Git\\bin\\bash.exe"));
    }

    #[cfg(windows)]
    #[test]
    fn a_store_installed_powershell_is_found_by_its_execution_alias() {
        let machine = FakeMachine::windows().file("C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe");
        assert_eq!(ids(&machine.detect_windows()), vec!["pwsh"]);
    }

    #[cfg(windows)]
    #[test]
    fn the_wsl_stub_without_distributions_adds_nothing() {
        let machine = FakeMachine::windows().file("C:\\Windows\\System32\\wsl.exe");
        assert!(machine.detect_windows().is_empty());
    }

    #[test]
    fn unix_puts_the_users_shell_first_dedupes_and_skips_non_shells() {
        let mut machine = FakeMachine::windows();
        machine.env.clear();
        machine.env.insert("SHELL", "/opt/homebrew/bin/fish".to_string());
        for path in ["/opt/homebrew/bin/fish", "/bin/zsh", "/bin/bash", "/usr/bin/bash", "/usr/bin/git-shell", "/bin/sh"] {
            machine.files.insert(PathBuf::from(path));
        }
        machine.etc_shells = Some("# List of acceptable shells\n/bin/bash\n/usr/bin/git-shell\n/bin/zsh\n".to_string());
        let found = machine.detect_unix();
        assert_eq!(ids(&found), vec!["fish", "bash", "zsh", "sh"]);
        assert_eq!(found[1].program, "/bin/bash");
        // Login shells: the PATH a Dock-launched app lacks comes from the profile.
        assert_eq!(found[1].args, vec!["-l"]);
        assert!(found[3].args.is_empty());
    }

    #[test]
    fn the_wsl_list_is_read_in_utf16_or_utf8() {
        let utf16: Vec<u8> = "\u{FEFF}Ubuntu\r\nDebian\r\n\r\n".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(parse_wsl_list(&utf16), vec!["Ubuntu", "Debian"]);
        assert_eq!(parse_wsl_list(b"Ubuntu-22.04\nkali-linux\n"), vec!["Ubuntu-22.04", "kali-linux"]);
        assert!(parse_wsl_list(b"").is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn choose_finds_by_id_defaults_to_the_first_and_refuses_unknown_ids() {
        let machine = FakeMachine::windows()
            .file("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
            .file("C:\\Windows\\system32\\cmd.exe");
        let found = machine.detect_windows();
        assert_eq!(choose(&found, None).unwrap().id, "powershell");
        assert_eq!(choose(&found, Some("")).unwrap().id, "powershell");
        assert_eq!(choose(&found, Some("cmd")).unwrap().id, "cmd");
        assert!(choose(&found, Some("C:\\evil.exe")).unwrap_err().contains("not installed"));
        assert!(choose(&[], None).is_err());
    }

    #[test]
    fn profiles_serialize_in_camel_case_without_their_private_environment() {
        let mut p = profile("git-bash", "Git Bash", Path::new("C:/Git/bin/bash.exe"), &["--login", "-i"], "bash");
        p.env.push(("CHERE_INVOKING".to_string(), "1".to_string()));
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["id"], "git-bash");
        assert_eq!(json["family"], "bash");
        assert!(json.get("env").is_none());
    }

    /// The real detector on the machine running the tests: every developer machine has
    /// at least one shell, and every profile it reports must point at a real program.
    #[test]
    fn detection_on_this_machine_finds_real_programs() {
        let found = detect();
        for p in &found {
            println!("{:<22} {:<24} {} {}", p.id, p.name, p.program, p.args.join(" "));
        }
        assert!(!found.is_empty(), "no shell detected");
        for p in &found {
            assert!(std::fs::symlink_metadata(&p.program).is_ok(), "{} points at a missing {}", p.id, p.program);
        }
        let ids: HashSet<&str> = found.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids.len(), found.len(), "duplicate profile ids");
    }
}
