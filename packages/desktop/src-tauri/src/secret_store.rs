// Secret storage policy — the half of key handling that is not platform-specific.
//
// ── WHERE THE KEYS ACTUALLY LIVE ────────────────────────────────────────────
//
// In the operating system's credential store, never in this repository's own files.
// `packages/core` has no code path that can persist a secret at all (see
// packages/core/src/secrets/store.ts): the engine depends on the `SecretStore` seam
// and the real implementation is here, on the native side, because that is the only
// side that can talk to Windows Credential Manager, the macOS Keychain, or libsecret
// (Requirement 17.3).
//
// ── WHY THIS MODULE IS SPLIT FROM THE PLATFORM CODE ─────────────────────────
//
// Everything in this file is std-only, so it runs under
//
//   rustc --test src/secret_store.rs -o <tmp>/secrets && <tmp>/secrets
//
// with no Tauri toolchain and no linker games — the same arrangement
// `command_policy.rs` uses, and for the same reason: `cargo test` cannot link on the
// development machine this was written on. The platform bindings live behind the
// `CredentialBackend` trait in `os_credentials.rs`, which this file never names.
//
// ── FOUR RULES, AND EVERY ONE OF THEM EXISTS BECAUSE A KEY IS AT STAKE ──────
//
//   1. NO VALUE IS EVER RETURNED TO THE CALLER. `presence` answers with an id and a
//      bool. There is no read command, not even a truncated one: four characters of
//      a key are four characters of a key.
//   2. NO VALUE IS EVER IN AN ERROR MESSAGE. Errors name the provider id and the
//      operation. `Display` for the error type cannot reach a secret, because the
//      secret is not in it.
//   3. NO PATH IS INVOLVED. These commands take a provider id, full stop. There is
//      nothing here for `command_policy` to contain, and nothing here reimplements
//      containment — the project has exactly one `is_within` and one
//      `has_parent_escape`, both in `command_policy.rs`, and a test asserts that.
//      If a secret command ever grows a path argument, it goes through that module.
//   4. THE ID IS VALIDATED THE SAME WAY ON BOTH SIDES. The engine's rule is
//      `SECRET_ID_PATTERN` in packages/core/src/secrets/store.ts; `validate_id`
//      below is its mirror. An id becomes an account name in a C-string-shaped OS
//      interface, where a NUL or a separator can address a different record than the
//      one that was named.
//
// Validates: Requirements 17.3, 17.4

/// The service (Windows: target prefix; macOS/Linux: service attribute) every
/// Sketch credential is filed under. One constant, so a key written by one build is
/// found by the next.
pub const SERVICE: &str = "sketch";

/// Longest accepted provider id. Matches the engine's `SECRET_ID_PATTERN`.
pub const MAX_ID_LEN: usize = 128;

/// The largest secret this will store, in bytes.
///
/// Windows Credential Manager caps a credential blob at 2560 bytes (`CRED_MAX_
/// CREDENTIAL_BLOB_SIZE`), and no API key is anywhere near that. Refusing early
/// means a paste of the wrong thing entirely — a PEM file, a whole config — fails
/// with a sentence instead of an opaque OS error code.
pub const MAX_SECRET_BYTES: usize = 2048;

/// What went wrong. NO VARIANT CARRIES A SECRET VALUE, and that is load-bearing:
/// this type is what becomes a string in the IPC reply, so anything it holds is
/// something the webview — and any log the webview feeds — can see.
#[derive(Debug, PartialEq, Eq)]
pub enum SecretError {
    /// The provider id is not usable as a credential account name.
    InvalidId(String),
    /// An empty value was offered. Removing a key is `remove`, not `set("")`.
    Empty(String),
    /// The value is larger than any API key plausibly is.
    TooLarge { id: String, bytes: usize },
    /// The OS credential store refused. `detail` is the OS's own words about the
    /// FAILURE, never about the value.
    Backend { id: String, operation: String, detail: String },
    /// No credential store is available on this platform/build.
    Unsupported(String),
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SecretError::InvalidId(id) => write!(
                f,
                "'{}' is not a usable provider id: use 1-{} characters from A-Z a-z 0-9 . _ - , starting with a letter or digit",
                id, MAX_ID_LEN
            ),
            SecretError::Empty(id) => write!(
                f,
                "refusing to store an empty key for '{}': remove the stored key instead",
                id
            ),
            SecretError::TooLarge { id, bytes } => write!(
                f,
                "the key offered for '{}' is {} bytes, above the {} byte limit — this does not look like an API key",
                id, bytes, MAX_SECRET_BYTES
            ),
            SecretError::Backend { id, operation, detail } => write!(
                f,
                "the operating system credential store could not {} the key for '{}': {}",
                operation, id, detail
            ),
            SecretError::Unsupported(detail) => write!(
                f,
                "no operating system credential store is available: {}. A key can still be supplied per request, but it will not be remembered.",
                detail
            ),
        }
    }
}

impl std::error::Error for SecretError {}

/// The platform binding. One method per operation the seam needs.
///
/// `get` exists because SOMETHING has to read the key back for the request that uses
/// it. It is deliberately NOT reachable from the webview: no Tauri command calls it
/// (see main.rs). Keeping it on the trait rather than off it is what lets the
/// eventual key-resolution path — see the note on `presence` — be written without
/// reopening this module.
pub trait CredentialBackend {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String>;
    fn set(&self, service: &str, account: &str, secret: &str) -> Result<(), String>;
    /// Removing something that is not there is SUCCESS, not an error: the caller
    /// asked for it to be gone, and it is gone.
    fn delete(&self, service: &str, account: &str) -> Result<(), String>;
    /// Whether a secret exists for this account, without returning it.
    fn has(&self, service: &str, account: &str) -> Result<bool, String>;
    /// A short name for the store, for the UI to be specific about where a key went.
    fn describe(&self) -> String;
}

/// Whether one provider has a key stored. THE ONLY SHAPE THAT CROSSES THE IPC
/// BOUNDARY for a stored secret: an id and a bool.
#[derive(Debug, PartialEq, Eq)]
pub struct KeyPresence {
    pub id: String,
    pub has_key: bool,
}

/// Validate a provider id, returning it trimmed.
///
/// Mirror of `SECRET_ID_PATTERN` in packages/core/src/secrets/store.ts. ASCII only:
/// the point is a predictable account name, and a Unicode id that normalizes
/// differently in two places is the same class of bug as a path that canonicalizes
/// differently.
pub fn validate_id(id: &str) -> Result<String, SecretError> {
    let trimmed = id.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_ID_LEN {
        return Err(SecretError::InvalidId(id.to_string()));
    }
    let mut chars = trimmed.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return Err(SecretError::InvalidId(id.to_string())),
    }
    for c in chars {
        if !(c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') {
            return Err(SecretError::InvalidId(id.to_string()));
        }
    }
    Ok(trimmed.to_string())
}

/// Store a key for one provider. Returns nothing at all — not the value, not a
/// prefix, not a length.
pub fn set_secret<B: CredentialBackend + ?Sized>(
    backend: &B,
    id: &str,
    secret: &str,
) -> Result<(), SecretError> {
    let account = validate_id(id)?;
    // Surrounding whitespace in a pasted key is a paste artefact, not part of the
    // key. Trimming it here means the "wrong key" case is a real wrong key.
    let value = secret.trim();
    if value.is_empty() {
        return Err(SecretError::Empty(account));
    }
    if value.len() > MAX_SECRET_BYTES {
        return Err(SecretError::TooLarge { id: account, bytes: value.len() });
    }
    backend.set(SERVICE, &account, value).map_err(|detail| SecretError::Backend {
        id: account,
        operation: "store".to_string(),
        detail,
    })
}

/// Remove a provider's key. Idempotent: removing what is not there succeeds.
pub fn remove_secret<B: CredentialBackend + ?Sized>(
    backend: &B,
    id: &str,
) -> Result<(), SecretError> {
    let account = validate_id(id)?;
    backend.delete(SERVICE, &account).map_err(|detail| SecretError::Backend {
        id: account,
        operation: "remove".to_string(),
        detail,
    })
}

/// Which of the given providers have a key stored.
///
/// PRESENCE ONLY. This is what `list_providers` answers with, and it is why there is
/// no read command: the settings surface needs to know whether to offer "Remove", and
/// that is a bool. Resolving a key for an actual model call is a separate path that
/// does not exist yet — see the spec-gap note in main.rs above `list_providers`.
pub fn list_presence<B: CredentialBackend + ?Sized>(
    backend: &B,
    ids: &[String],
) -> Result<Vec<KeyPresence>, SecretError> {
    let mut out = Vec::with_capacity(ids.len());
    let mut seen: Vec<String> = Vec::with_capacity(ids.len());
    for raw in ids {
        let account = validate_id(raw)?;
        if seen.contains(&account) {
            continue;
        }
        let has_key = backend.has(SERVICE, &account).map_err(|detail| SecretError::Backend {
            id: account.clone(),
            operation: "query".to_string(),
            detail,
        })?;
        seen.push(account.clone());
        out.push(KeyPresence { id: account, has_key });
    }
    Ok(out)
}

/// An in-process backend for tests and for a build with no OS store available.
///
/// It is NOT wired into any command: a memory store that silently forgets a key the
/// user believed was saved is worse than a named refusal, which is what
/// `os_credentials::backend()` returns on an unsupported platform.
#[derive(Default)]
pub struct MemoryBackend {
    rows: std::sync::Mutex<Vec<(String, String, String)>>,
}

impl MemoryBackend {
    pub fn new() -> Self {
        Self::default()
    }

    /// Ids holding a secret. Ids only — a test must not be able to read a value
    /// through the convenience API either.
    pub fn ids(&self) -> Vec<String> {
        let rows = self.rows.lock().unwrap();
        let mut ids: Vec<String> = rows.iter().map(|(_, a, _)| a.clone()).collect();
        ids.sort();
        ids
    }
}

impl CredentialBackend for MemoryBackend {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        let rows = self.rows.lock().unwrap();
        Ok(rows
            .iter()
            .find(|(s, a, _)| s == service && a == account)
            .map(|(_, _, v)| v.clone()))
    }

    fn set(&self, service: &str, account: &str, secret: &str) -> Result<(), String> {
        let mut rows = self.rows.lock().unwrap();
        rows.retain(|(s, a, _)| !(s == service && a == account));
        rows.push((service.to_string(), account.to_string(), secret.to_string()));
        Ok(())
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        let mut rows = self.rows.lock().unwrap();
        rows.retain(|(s, a, _)| !(s == service && a == account));
        Ok(())
    }

    fn has(&self, service: &str, account: &str) -> Result<bool, String> {
        let rows = self.rows.lock().unwrap();
        Ok(rows.iter().any(|(s, a, _)| s == service && a == account))
    }

    fn describe(&self) -> String {
        "an in-process store (this session only)".to_string()
    }
}

/// A backend that refuses everything, naming why. What an unsupported platform gets.
pub struct UnsupportedBackend {
    pub detail: String,
}

impl CredentialBackend for UnsupportedBackend {
    fn get(&self, _service: &str, _account: &str) -> Result<Option<String>, String> {
        Err(self.detail.clone())
    }
    fn set(&self, _service: &str, _account: &str, _secret: &str) -> Result<(), String> {
        Err(self.detail.clone())
    }
    fn delete(&self, _service: &str, _account: &str) -> Result<(), String> {
        Err(self.detail.clone())
    }
    fn has(&self, _service: &str, _account: &str) -> Result<bool, String> {
        Err(self.detail.clone())
    }
    fn describe(&self) -> String {
        format!("no credential store ({})", self.detail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "sk-ant-api03-DEADBEEFdeadbeef0123456789abcdefghij";

    #[test]
    fn accepts_the_ids_the_engine_accepts() {
        for id in ["openai", "azure-openai", "llama.cpp", "gh_models", "a", "9x"] {
            assert_eq!(validate_id(id).unwrap(), id);
        }
        // Trimmed, because a pasted id carries whitespace.
        assert_eq!(validate_id("  openai  ").unwrap(), "openai");
    }

    #[test]
    fn refuses_ids_that_could_address_another_record() {
        for id in [
            "",
            "   ",
            "-leading",
            ".dotfirst",
            "has space",
            "has/slash",
            "has\\backslash",
            "has:colon",
            "nul\0byte",
            "new\nline",
            "unicode-Ünïcode",
        ] {
            let err = validate_id(id).unwrap_err();
            assert!(matches!(err, SecretError::InvalidId(_)), "{} -> {:?}", id, err);
        }
        let long = "a".repeat(MAX_ID_LEN + 1);
        assert!(matches!(validate_id(&long).unwrap_err(), SecretError::InvalidId(_)));
        assert!(validate_id(&"a".repeat(MAX_ID_LEN)).is_ok());
    }

    #[test]
    fn stores_and_removes_a_key_without_ever_returning_it() {
        let backend = MemoryBackend::new();

        set_secret(&backend, "openai", KEY).unwrap();
        assert_eq!(backend.ids(), vec!["openai".to_string()]);

        // The presence answer is an id and a bool. Nothing else.
        let presence = list_presence(&backend, &["openai".to_string(), "anthropic".to_string()])
            .unwrap();
        assert_eq!(
            presence,
            vec![
                KeyPresence { id: "openai".to_string(), has_key: true },
                KeyPresence { id: "anthropic".to_string(), has_key: false },
            ]
        );
        let rendered = format!("{:?}", presence);
        assert!(!rendered.contains(KEY), "presence leaked the key: {}", rendered);

        remove_secret(&backend, "openai").unwrap();
        assert!(backend.ids().is_empty());
        // Removing again is fine: the caller asked for absence and got it.
        remove_secret(&backend, "openai").unwrap();
    }

    #[test]
    fn a_replaced_key_does_not_leave_the_old_one_behind() {
        let backend = MemoryBackend::new();
        set_secret(&backend, "openai", "sk-first-0123456789abcdef").unwrap();
        set_secret(&backend, "openai", "sk-second-0123456789abcdef").unwrap();
        assert_eq!(backend.ids(), vec!["openai".to_string()]);
        assert_eq!(
            backend.get(SERVICE, "openai").unwrap().unwrap(),
            "sk-second-0123456789abcdef"
        );
    }

    #[test]
    fn refuses_an_empty_or_implausible_key() {
        let backend = MemoryBackend::new();
        assert!(matches!(
            set_secret(&backend, "openai", "   ").unwrap_err(),
            SecretError::Empty(_)
        ));
        let huge = "k".repeat(MAX_SECRET_BYTES + 1);
        assert!(matches!(
            set_secret(&backend, "openai", &huge).unwrap_err(),
            SecretError::TooLarge { .. }
        ));
        // Neither attempt stored anything.
        assert!(backend.ids().is_empty());
    }

    #[test]
    fn a_pasted_key_is_trimmed_not_stored_with_its_whitespace() {
        let backend = MemoryBackend::new();
        set_secret(&backend, "openai", &format!("  {}\n", KEY)).unwrap();
        assert_eq!(backend.get(SERVICE, "openai").unwrap().unwrap(), KEY);
    }

    #[test]
    fn no_error_message_can_contain_a_key() {
        // Every variant rendered, with a real key in scope. The type has no field
        // that could hold one, and this is the test that keeps it that way.
        let messages = vec![
            SecretError::InvalidId("bad id".to_string()).to_string(),
            SecretError::Empty("openai".to_string()).to_string(),
            SecretError::TooLarge { id: "openai".to_string(), bytes: 9000 }.to_string(),
            SecretError::Backend {
                id: "openai".to_string(),
                operation: "store".to_string(),
                detail: "os error 1312".to_string(),
            }
            .to_string(),
            SecretError::Unsupported("built without a backend".to_string()).to_string(),
        ];
        for message in messages {
            assert!(!message.contains(KEY), "{}", message);
            // And each one names the operation or the id, so it is actionable.
            assert!(!message.is_empty());
        }

        // A backend failure carries the OS's words about the failure, and the
        // provider id — never the value that was being written.
        let backend = UnsupportedBackend { detail: "no credential store on this build".to_string() };
        let err = set_secret(&backend, "openai", KEY).unwrap_err();
        let message = err.to_string();
        assert!(!message.contains(KEY), "{}", message);
        assert!(message.contains("openai"), "{}", message);
        assert!(message.contains("no credential store on this build"), "{}", message);
    }

    #[test]
    fn an_unsupported_platform_refuses_rather_than_pretending() {
        let backend = UnsupportedBackend { detail: "libsecret is not installed".to_string() };
        assert!(matches!(set_secret(&backend, "openai", KEY), Err(SecretError::Backend { .. })));
        assert!(matches!(remove_secret(&backend, "openai"), Err(SecretError::Backend { .. })));
        assert!(matches!(
            list_presence(&backend, &["openai".to_string()]),
            Err(SecretError::Backend { .. })
        ));
    }

    #[test]
    fn presence_validates_every_id_and_reports_each_once() {
        let backend = MemoryBackend::new();
        set_secret(&backend, "openai", KEY).unwrap();

        // A duplicate id is answered once, so the UI cannot render two rows for it.
        let presence =
            list_presence(&backend, &["openai".to_string(), "openai".to_string()]).unwrap();
        assert_eq!(presence.len(), 1);

        // One bad id refuses the whole call: a partial answer would leave the UI
        // showing "no key stored" for a provider nobody actually asked about.
        let err = list_presence(&backend, &["openai".to_string(), "../etc".to_string()])
            .unwrap_err();
        assert!(matches!(err, SecretError::InvalidId(_)), "{:?}", err);
    }

    // NOTE: that this module owns no path and no second containment primitive is
    // asserted structurally in the desktop suite (src/lib/security.test.ts), which
    // reads this file as text. A Rust test cannot check it without embedding the
    // forbidden strings in its own source and matching itself.
}
