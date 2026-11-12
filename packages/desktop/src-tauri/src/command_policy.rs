// Path containment and terminal policy for the Tauri commands.
//
// ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
//
// Everything the webview can reach in `main.rs` is ordinary Rust. A
// `#[tauri::command]` is NOT covered by the `fs.scope` in tauri.conf.json — that
// scope constrains `tauri-plugin-fs` APIs only. So a custom `read_file(path)`
// command reads whatever the OS user can read, and a custom `write_file` writes
// wherever the OS user can write, plugin scope or not. Containment therefore has to
// live here, in one place, and every command that touches a path has to go through
// it. Two containment implementations that can disagree is how one of them ends up
// wrong.
//
// ── THE TERMINAL TOOL'S SHAPE ───────────────────────────────────────────────
//
// The previous implementation matched substrings ("rm -rf", "sudo ") against a
// command line and then handed the line to `sh -c` / `cmd /C`. That is not a
// sandbox. `rm -fr`, `rm  -rf`, `rm -r -f`, `find . -delete` all walk straight
// through it, and nothing in it addresses exfiltration at all — a POST of
// `~/.ssh/id_rsa` contains no forbidden substring. A denylist can only refuse the
// spellings somebody thought of.
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
// Validates: Requirements 22.6, 22.4, 13.8

use std::path::{Component, Path, PathBuf};

/// Programs the terminal tool may start.
///
/// Chosen as the smallest set that covers what this dev tool actually drives: the
/// verification stages the engine already runs (`npm`, `node`), version control
/// (`git`), and the two other toolchains the repo and its users build with
/// (`cargo`, `python`).
///
/// WHAT THIS LIST DOES AND DOES NOT DO. It bounds WHICH programs start. It does not
/// bound what they do. Every entry here can execute arbitrary code by design:
/// `node` and `python` both take a program on the command line, `cargo` runs
/// build scripts, `git` runs hooks, and `npm test` runs whatever the project's
/// package.json says — which is the entire point of the verify loop. No allowlist
/// that contains a build tool can prevent arbitrary execution, and this one does not
/// claim to. `sh`/`bash`/`cmd`/`powershell` and `npx` are absent because they add
/// nothing this tool needs, not because their absence buys a guarantee.
///
/// THE ACTUAL BOUNDARIES are three, and they are the ones worth defending:
///   - the explicit confirmation gate: nothing starts without a user saying so;
///   - the contained working directory: a command starts inside the open project;
///   - the absence of a shell: argument bytes are never re-parsed, so injection
///     through metacharacters in a filename or a model-authored argument is not
///     possible. That stops *unintended* execution. It does not stop intentional
///     execution, and nothing at this layer could.
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

// ── Containment ─────────────────────────────────────────────────────────────

/// Component-wise containment. `Path::starts_with` compares components, not bytes,
/// so a sibling directory named like a prefix of the root cannot pass.
fn is_within(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

/// The project root as a user should see it in a message.
///
/// `std::fs::canonicalize` on Windows returns an EXTENDED-LENGTH ("verbatim") path:
/// `\\?\C:\Users\me\project`, or `\\?\UNC\server\share` for a UNC path. That prefix
/// is a Win32 API detail — it tells the OS to skip path parsing — and it is never a
/// spelling a user typed or recognises. Printed in a containment refusal it reads as
/// a *different* location than the folder they opened ("a different workspace
/// boundary"), which is exactly the confusion this strips away. The containment test
/// itself still runs on the real canonical `PathBuf`; only the DISPLAYED string is
/// cleaned, so nothing about what is allowed changes.
///
/// On non-Windows targets there is no verbatim prefix, so this is `display()`.
fn display_root(root: &Path) -> String {
    let shown = root.display().to_string();
    #[cfg(windows)]
    {
        // `\\?\UNC\server\share` is really `\\server\share`.
        if let Some(rest) = shown.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{}", rest);
        }
        // `\\?\C:\path` is really `C:\path`.
        if let Some(rest) = shown.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    shown
}

/// Reject a path that tries to climb with `..` before the disk is even consulted,
/// so the error names the real problem. Applied to absolute and relative candidates
/// alike: an absolute path with `..` in it has no legitimate use here, and refusing
/// it early keeps the resolved path a pure prefix extension of the root.
fn has_parent_escape(path: &Path) -> bool {
    path.components().any(|c| matches!(c, Component::ParentDir))
}

/// Resolve the open project root: non-empty, existing, canonical, a directory.
///
/// Canonicalizing here is half of what makes containment work — comparing a
/// canonical candidate against a non-canonical root would fail on any machine where
/// the root itself sits behind a symlink (`/tmp` on macOS, for one).
///
/// PUBLIC because a command can need the root itself and no candidate under it:
/// `git_status` spawns `git` with the project as its working directory, and it used
/// to pass the caller's string to `current_dir` unexamined — which is how a webview
/// could run `git` in any directory on disk. It now asks here instead, so "the open
/// project root" means one thing everywhere (Requirement 13.8).
pub fn resolve_root(project_root: &str) -> Result<PathBuf, String> {
    if project_root.trim().is_empty() {
        return Err("no project root is open, so no path may be used".to_string());
    }

    let root = PathBuf::from(project_root)
        .canonicalize()
        .map_err(|e| format!("project root '{}' is not usable: {}", project_root, e))?;

    if !root.is_dir() {
        return Err(format!("project root '{}' is not a directory", project_root));
    }
    Ok(root)
}

/// Join a caller-supplied candidate onto the root without letting it climb.
///
/// A relative candidate is taken as project-relative. An absolute one is used as
/// given and caught later by containment.
fn absolutize(root: &Path, candidate: &str, label: &str) -> Result<PathBuf, String> {
    let raw = PathBuf::from(candidate);
    if has_parent_escape(&raw) {
        return Err(format!(
            "{} '{}' escapes the open folder {}",
            label,
            candidate,
            display_root(root)
        ));
    }
    Ok(if raw.is_relative() {
        root.join(raw)
    } else {
        raw
    })
}

/// The one containment error, so every command reports an escape the same way.
///
/// Deliberately reports the path AS THE CALLER GAVE IT, not the canonical target.
/// Echoing the resolved path would turn a refusal into a disclosure — where a
/// symlink actually points, or which of several roots exists.
///
/// The root is shown through `display_root`, so a Windows user sees the folder they
/// opened (`C:\Users\me\project`) and not its verbatim form (`\\?\C:\Users\me\project`),
/// which read as a boundary they never set. The message names the file, names the
/// open folder, and says what to do — open the folder that contains the file — so the
/// refusal is actionable rather than a dead end. This is message wording only; the
/// containment decision above it is unchanged.
fn outside(label: &str, candidate: &str, root: &Path) -> String {
    format!(
        "This {label} is outside the folder you have open in Sketch, so it cannot be \
         reached from here:\n  {label}: {candidate}\n  open folder: {root}\n\
         To work with it, open the folder that contains it (File \u{2192} Open Folder).",
        label = label,
        candidate = candidate,
        root = display_root(root),
    )
}

/// Resolve an EXISTING path and require it to sit inside the open project root.
///
/// This is the single containment primitive: `resolve_cwd`, `resolve_dir_within`
/// and `resolve_file_within` are all thin wrappers over it, so there is exactly one
/// implementation of "inside the project" to get right.
///
/// SYMLINKS. `canonicalize` resolves every link in the candidate before the prefix
/// test, so a symlink that lives inside the root but points outside it resolves to
/// its real target and fails containment. That is why the candidate is canonicalized
/// rather than merely lexically normalized.
pub fn resolve_within(project_root: &str, candidate: &str, label: &str) -> Result<PathBuf, String> {
    let root = resolve_root(project_root)?;
    if candidate.trim().is_empty() {
        return Err(format!("no {} given", label));
    }

    let requested = absolutize(&root, candidate, label)?;
    let resolved = requested
        .canonicalize()
        .map_err(|e| format!("invalid {} '{}': {}", label, candidate, e))?;

    if !is_within(&root, &resolved) {
        return Err(outside(label, candidate, &root));
    }
    Ok(resolved)
}

/// A contained directory that already exists.
pub fn resolve_dir_within(project_root: &str, candidate: &str) -> Result<PathBuf, String> {
    let resolved = resolve_within(project_root, candidate, "directory")?;
    if !resolved.is_dir() {
        return Err(format!("not a directory: '{}'", candidate));
    }
    Ok(resolved)
}

/// A contained regular file that already exists.
pub fn resolve_file_within(project_root: &str, candidate: &str) -> Result<PathBuf, String> {
    let resolved = resolve_within(project_root, candidate, "file")?;
    if resolved.is_dir() {
        return Err(format!("not a file: '{}'", candidate));
    }
    Ok(resolved)
}

/// Resolve a write target that MAY NOT EXIST YET.
///
/// `canonicalize` fails on a path that is not there, so a new file cannot be
/// resolved the way a read can. Instead:
///
///   1. refuse `..` anywhere in the candidate, so no component can climb;
///   2. require the final component to be a plain name — not `.`, not `..`, not a
///      root or drive prefix — so the last segment adds no traversal either;
///   3. walk up to the NEAREST EXISTING ANCESTOR, canonicalize that, and contain
///      it. Everything below that ancestor does not exist yet, so it cannot hold a
///      symlink, and every remaining segment is a plain name. The rebuilt path is
///      therefore a pure extension of a contained real directory.
///
/// DECISION: missing intermediate directories are allowed, because `write_file` has
/// always created them and saving a file into a new folder is a normal editor
/// action. What changed is that the deepest directory that actually exists must be
/// inside the project, so `create_dir_all` can only ever build downward from there.
pub fn resolve_write_target(project_root: &str, candidate: &str) -> Result<PathBuf, String> {
    let label = "file";
    let root = resolve_root(project_root)?;
    if candidate.trim().is_empty() {
        return Err(format!("no {} given", label));
    }

    let absolute = absolutize(&root, candidate, label)?;

    match absolute.components().next_back() {
        Some(Component::Normal(_)) => {}
        _ => {
            return Err(format!(
                "{} '{}' does not name a file to write",
                label, candidate
            ))
        }
    }

    // The deepest ancestor that exists on disk, plus the segments still missing.
    let mut missing: Vec<Component<'_>> = Vec::new();
    let mut cursor: &Path = absolute.as_path();
    let existing = loop {
        // `symlink_metadata`, not `exists`: a BROKEN symlink exists as a link even
        // though `exists()` (which follows links) says no. Treating it as missing
        // would rebuild the path around it and let a write follow the link
        // wherever it points. Counted as existing, it reaches `canonicalize`
        // below, which fails on a dangling link, and the write is refused.
        if cursor.symlink_metadata().is_ok() {
            break cursor;
        }
        let Some(name) = cursor.components().next_back() else {
            return Err(outside(label, candidate, &root));
        };
        missing.push(name);
        match cursor.parent() {
            // Ran out of ancestors without finding one on disk: the candidate is not
            // anchored anywhere real, which is not something to create blindly.
            Some(parent) if !parent.as_os_str().is_empty() => cursor = parent,
            _ => return Err(outside(label, candidate, &root)),
        }
    };

    let anchor = existing
        .canonicalize()
        .map_err(|e| format!("invalid {} '{}': {}", label, candidate, e))?;

    if !is_within(&root, &anchor) {
        return Err(outside(label, candidate, &root));
    }
    // A missing tail below a plain file would mean treating a file as a directory.
    if !missing.is_empty() && !anchor.is_dir() {
        return Err(format!(
            "{} '{}' is not writable: '{}' is not a directory",
            label,
            candidate,
            existing.display()
        ));
    }
    // The path exists already and is a directory: a write would clobber a tree.
    if missing.is_empty() && anchor.is_dir() {
        return Err(format!("cannot write to a directory: '{}'", candidate));
    }

    let mut target = anchor;
    for component in missing.iter().rev() {
        match component {
            Component::Normal(name) => target.push(name),
            // Unreachable given the `..` refusal above; refused rather than trusted.
            _ => return Err(outside(label, candidate, &root)),
        }
    }
    Ok(target)
}

/// Resolve a caller-supplied git pathspec to a contained path.
///
/// ── WHY A PATHSPEC NEEDS ITS OWN DOOR ───────────────────────────────────────
///
/// `git_diff` used to push the caller's `file` straight into the argument vector.
/// There is no shell in that path, so nothing could inject a command — but GIT
/// PARSES ITS OWN ARGUMENTS, and an argument that begins with `-` is an option, not
/// a path. `git diff --output=<file>` writes wherever it is pointed, so an
/// unvalidated `file` was a write primitive with the same reach the fs commands were
/// hardened against, arriving through a command that looks read-only
/// (Requirement 13.8).
///
/// Two defences, and both are applied:
///   1. anything that could be read as an option is refused BY NAME here, so the
///      refusal says what was wrong instead of failing obscurely inside git;
///   2. the caller puts `--` before the pathspec, so git stops option parsing
///      whatever this function let through.
///
/// ── A MISSING PATH IS STILL A PATH ──────────────────────────────────────────
///
/// `git diff` over a DELETED file is an ordinary request, and `canonicalize` fails on
/// something that is not on disk, so `resolve_within` alone would refuse the most
/// interesting diff there is. A candidate that does not resolve therefore falls back
/// to `resolve_write_target`'s nearest-existing-ancestor walk — reused, not
/// reimplemented, so there is still exactly one prefix test under both. The fallback
/// also owns the error when both fail: it is the branch that understands a path that
/// is not there, so its message is the accurate one.
pub fn resolve_pathspec_within(project_root: &str, candidate: &str) -> Result<PathBuf, String> {
    let requested = candidate.trim();
    if requested.is_empty() {
        return Err("no path given".to_string());
    }
    if requested.starts_with('-') {
        return Err(format!(
            "path '{}' is refused: git would read it as an option, not a path",
            candidate
        ));
    }

    match resolve_within(project_root, candidate, "path") {
        Ok(resolved) => Ok(resolved),
        Err(_) => resolve_write_target(project_root, candidate),
    }
}

/// Resolve the working directory for a spawned command, refusing anything outside
/// the open project root. An empty `cwd` means the project root itself.
pub fn resolve_cwd(project_root: &str, cwd: &str) -> Result<PathBuf, String> {
    if cwd.trim().is_empty() {
        return resolve_root(project_root);
    }
    let resolved = resolve_within(project_root, cwd, "working directory")?;
    if !resolved.is_dir() {
        return Err(format!("invalid working directory: '{}'", cwd));
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

    /// A fresh directory per test, so one test's leftovers cannot make another pass.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sketch-policy-{}", name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, b"x").unwrap();
    }

    fn s(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

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
        let root = scratch("cwd-root");
        let inside = root.join("nested");
        std::fs::create_dir_all(&inside).unwrap();
        let outside = scratch("cwd-outside");

        let root_str = s(&root);

        assert!(resolve_cwd(&root_str, &s(&inside)).is_ok());
        assert!(resolve_cwd(&root_str, "nested").is_ok());
        // Empty means the root itself.
        assert_eq!(resolve_cwd(&root_str, "").unwrap(), root);

        let err = resolve_cwd(&root_str, &s(&outside)).unwrap_err();
        assert!(err.contains("outside the folder you have open"), "{}", err);

        let err = resolve_cwd(&root_str, "../..").unwrap_err();
        assert!(err.contains("escapes the open folder"), "{}", err);
    }

    // ── Requirement 13.8: read/write paths are contained the same way ────────

    #[test]
    fn a_file_inside_the_root_resolves() {
        let root = scratch("read-inside");
        let file = root.join("src").join("main.ts");
        touch(&file);

        // Relative and absolute spellings of the same file both resolve to it.
        assert_eq!(resolve_file_within(&s(&root), "src/main.ts").unwrap(), file);
        assert_eq!(resolve_file_within(&s(&root), &s(&file)).unwrap(), file);

        let dir = resolve_dir_within(&s(&root), "src").unwrap();
        assert_eq!(dir, root.join("src"));
    }

    #[test]
    fn a_parent_escape_is_refused_before_the_disk_is_touched() {
        let root = scratch("read-escape");
        let secret = root.parent().unwrap().join("sketch-policy-secret.txt");
        touch(&secret);

        for candidate in [
            "../sketch-policy-secret.txt",
            "src/../../sketch-policy-secret.txt",
            "..",
        ] {
            let err = resolve_file_within(&s(&root), candidate).unwrap_err();
            assert!(err.contains("escapes the open folder"), "{}", err);
        }
        // The same rule applies to the write side.
        let err = resolve_write_target(&s(&root), "../escaped.txt").unwrap_err();
        assert!(err.contains("escapes the open folder"), "{}", err);
    }

    #[test]
    fn an_absolute_path_outside_the_root_is_refused() {
        let root = scratch("read-absolute");
        let outside = scratch("read-absolute-outside");
        let file = outside.join("id_rsa");
        touch(&file);

        let err = resolve_file_within(&s(&root), &s(&file)).unwrap_err();
        assert!(err.contains("outside the folder you have open"), "{}", err);

        let err = resolve_dir_within(&s(&root), &s(&outside)).unwrap_err();
        assert!(err.contains("outside the folder you have open"), "{}", err);

        let err = resolve_write_target(&s(&root), &s(&outside.join("planted.txt"))).unwrap_err();
        assert!(err.contains("outside the folder you have open"), "{}", err);
    }

    #[test]
    fn a_write_target_that_does_not_exist_yet_is_allowed_inside_the_root() {
        let root = scratch("write-new");

        // Existing parent, new file.
        std::fs::create_dir_all(root.join("src")).unwrap();
        assert_eq!(
            resolve_write_target(&s(&root), "src/new.ts").unwrap(),
            root.join("src").join("new.ts")
        );

        // NONEXISTENT PARENT: the deepest existing ancestor is the root, which is
        // contained, so the missing segments are rebuilt beneath it.
        assert_eq!(
            resolve_write_target(&s(&root), "a/b/c/deep.ts").unwrap(),
            root.join("a").join("b").join("c").join("deep.ts")
        );

        // An existing file is a legal target: overwriting in place is a save.
        let existing = root.join("src").join("app.ts");
        touch(&existing);
        assert_eq!(resolve_write_target(&s(&root), "src/app.ts").unwrap(), existing);
    }

    #[test]
    fn a_write_target_must_name_a_file_under_a_real_directory() {
        let root = scratch("write-shape");
        std::fs::create_dir_all(root.join("src")).unwrap();
        touch(&root.join("src").join("app.ts"));

        // A directory is not a write target.
        let err = resolve_write_target(&s(&root), "src").unwrap_err();
        assert!(err.contains("cannot write to a directory"), "{}", err);

        // A file cannot be treated as a directory to create children under.
        let err = resolve_write_target(&s(&root), "src/app.ts/child.ts").unwrap_err();
        assert!(err.contains("not a directory"), "{}", err);

        // A filesystem root names no file to write.
        let err = resolve_write_target(&s(&root), "/").unwrap_err();
        assert!(err.contains("does not name a file"), "{}", err);

        assert!(resolve_write_target(&s(&root), "").is_err());
    }

    #[test]
    fn missing_project_root_refuses_everything() {
        for root in ["", "   "] {
            assert!(resolve_cwd(root, "anywhere").is_err());
            // Even the "no cwd means the root" path has no root to fall back to.
            assert!(resolve_cwd(root, "").is_err());
            assert!(resolve_file_within(root, "package.json").is_err());
            assert!(resolve_dir_within(root, ".").is_err());
            assert!(resolve_write_target(root, "package.json").is_err());

            // An absolute path is not a way to operate without a project open.
            let anywhere = s(&std::env::temp_dir());
            assert!(resolve_file_within(root, &anywhere).is_err());
            assert!(resolve_write_target(root, &anywhere).is_err());
        }
    }

    // ── Requirement 13.8: the git commands are contained too ─────────────────

    #[test]
    fn git_needs_a_real_contained_project_root() {
        let root = scratch("git-root");
        assert_eq!(resolve_root(&s(&root)).unwrap(), root);

        // No project open: nothing to run git in.
        for empty in ["", "   "] {
            let err = resolve_root(empty).unwrap_err();
            assert!(err.contains("no project root is open"), "{}", err);
        }

        // A path that is not there, and a path that is a file, are both refused —
        // `git_status` used to hand either straight to `current_dir`.
        let missing = root.join("does-not-exist");
        assert!(resolve_root(&s(&missing)).is_err());
        let file = root.join("file.txt");
        touch(&file);
        assert!(resolve_root(&s(&file)).is_err());
    }

    #[test]
    fn a_git_pathspec_inside_the_root_resolves() {
        let root = scratch("git-pathspec");
        let tracked = root.join("src").join("main.ts");
        touch(&tracked);

        assert_eq!(
            resolve_pathspec_within(&s(&root), "src/main.ts").unwrap(),
            tracked
        );
        assert_eq!(
            resolve_pathspec_within(&s(&root), &s(&tracked)).unwrap(),
            tracked
        );
        // A directory is a legal pathspec: `git diff -- src` is a normal request.
        assert_eq!(
            resolve_pathspec_within(&s(&root), "src").unwrap(),
            root.join("src")
        );
        // A DELETED file still has a diff, so a missing path resolves rather than
        // failing on canonicalize.
        assert_eq!(
            resolve_pathspec_within(&s(&root), "src/deleted.ts").unwrap(),
            root.join("src").join("deleted.ts")
        );
    }

    #[test]
    fn a_git_pathspec_that_looks_like_an_option_is_refused() {
        let root = scratch("git-option");

        // The one that matters: `git diff --output=<path>` writes to that path.
        for candidate in [
            "--output=/tmp/pwned",
            "--output=pwned.txt",
            "-O/tmp/pwned",
            "--no-index",
            "  --output=x  ",
        ] {
            let err = resolve_pathspec_within(&s(&root), candidate).unwrap_err();
            assert!(
                err.contains("git would read it as an option"),
                "{} -> {}",
                candidate,
                err
            );
        }

        assert!(resolve_pathspec_within(&s(&root), "").is_err());
        assert!(resolve_pathspec_within(&s(&root), "   ").is_err());
    }

    #[test]
    fn a_git_pathspec_outside_the_root_is_refused() {
        let root = scratch("git-escape");
        let outside = scratch("git-escape-outside");
        let secret = outside.join("id_rsa");
        touch(&secret);

        // `..` is refused before the disk is consulted, existing or not.
        for candidate in ["../escape", "../git-escape-outside/id_rsa", "src/../../x"] {
            let err = resolve_pathspec_within(&s(&root), candidate).unwrap_err();
            assert!(err.contains("escapes the open folder"), "{}", err);
        }

        // An absolute path elsewhere on disk fails containment, present or absent.
        let err = resolve_pathspec_within(&s(&root), &s(&secret)).unwrap_err();
        assert!(err.contains("outside the folder you have open"), "{}", err);
        let err = resolve_pathspec_within(&s(&root), &s(&outside.join("nope"))).unwrap_err();
        assert!(err.contains("outside the folder you have open"), "{}", err);

        // And with no project open there is no pathspec at all.
        assert!(resolve_pathspec_within("", "src/main.ts").is_err());
    }

    /// A symlink that lives inside the root but points outside it must not pass.
    ///
    /// Symlink creation needs elevation or Developer Mode on Windows. If it fails,
    /// the test reports that it could not run rather than passing vacuously.
    #[test]
    fn a_symlink_out_of_the_root_is_refused() {
        let root = scratch("symlink-root");
        let outside = scratch("symlink-outside");
        let secret = outside.join("id_rsa");
        touch(&secret);

        let link = root.join("escape.txt");
        let dir_link = root.join("escape-dir");

        #[cfg(unix)]
        let made = {
            use std::os::unix::fs::symlink;
            symlink(&secret, &link).is_ok() && symlink(&outside, &dir_link).is_ok()
        };
        #[cfg(windows)]
        let made = {
            use std::os::windows::fs::{symlink_dir, symlink_file};
            symlink_file(&secret, &link).is_ok() && symlink_dir(&outside, &dir_link).is_ok()
        };
        #[cfg(not(any(unix, windows)))]
        let made = false;

        if !made {
            eprintln!(
                "SKIPPED a_symlink_out_of_the_root_is_refused: this platform did not permit \
                 creating a symlink (Windows needs Developer Mode or elevation). The \
                 containment path is unchanged either way: the candidate is canonicalized, \
                 which resolves links before the prefix test."
            );
            return;
        }

        let err = resolve_file_within(&s(&root), "escape.txt").unwrap_err();
        assert!(err.contains("outside the folder you have open"), "{}", err);

        let err = resolve_dir_within(&s(&root), "escape-dir").unwrap_err();
        assert!(err.contains("outside the folder you have open"), "{}", err);

        // Writing THROUGH the link is refused too: the link exists, so it is
        // canonicalized, and its real target fails containment.
        let err = resolve_write_target(&s(&root), "escape.txt").unwrap_err();
        assert!(err.contains("outside the folder you have open"), "{}", err);

        let err = resolve_write_target(&s(&root), "escape-dir/planted.txt").unwrap_err();
        assert!(err.contains("outside the folder you have open"), "{}", err);
    }

    /// The containment refusal must read in the user's own terms: it names the file,
    /// names the folder they opened, tells them what to do, and shows the OPEN FOLDER
    /// WITHOUT the Windows `\\?\` verbatim prefix that `canonicalize` adds. That prefix
    /// on the open-folder line is exactly what made the message read as "a different
    /// workspace boundary" (BUG_AUDIT B-001).
    #[test]
    fn the_refusal_names_the_file_and_the_open_folder_without_a_verbatim_prefix() {
        // A project whose name contains a space, like the reported `unicef india`.
        let root = scratch("unicef india");
        let outside = scratch("unicef india outside");
        let intruder = outside.join("index.mjs");
        touch(&intruder);

        // The caller (the UI) passes a HUMAN-SPELLED absolute path, never a verbatim one:
        // this is the shape `read_file`/`write_file` receive from the editor.
        let human_candidate = intruder.to_string_lossy().replace(r"\\?\", "");
        let err = resolve_file_within(&s(&root), &human_candidate).unwrap_err();

        // It names the file the caller asked for, and tells them what to do.
        assert!(err.contains("index.mjs"), "{}", err);
        assert!(err.contains("Open Folder"), "{}", err);

        // The OPEN-FOLDER line — the one `display_root` controls — carries no verbatim
        // prefix. (We check that line specifically; the caller-supplied candidate line is
        // echoed verbatim and is the caller's own spelling, not ours to rewrite.)
        let open_folder_line = err
            .lines()
            .find(|l| l.trim_start().starts_with("open folder:"))
            .expect("the refusal should name the open folder");
        assert!(
            !open_folder_line.contains(r"\\?\"),
            "the open-folder line still shows a verbatim prefix: {}",
            open_folder_line
        );

        // `display_root` strips the prefix for display while the real canonical path
        // (what containment compares) keeps it — the two are allowed to differ.
        let canonical = resolve_root(&s(&root)).unwrap();
        let shown = display_root(&canonical);
        assert!(!shown.contains(r"\\?\"), "display_root left a prefix: {}", shown);
        #[cfg(windows)]
        {
            // On Windows the real canonical form DOES begin with the prefix, proving
            // the strip is doing real work rather than matching nothing.
            assert!(
                canonical.to_string_lossy().starts_with(r"\\?\"),
                "expected a verbatim canonical path on Windows, got {}",
                canonical.display()
            );
            // The stripped form still points at the same place, spelled normally.
            assert!(
                shown.to_lowercase().ends_with("unicef india"),
                "stripped root should still name the folder: {}",
                shown
            );
        }
    }
}
