// The platform bindings for `secret_store::CredentialBackend`.
//
// This is the only file in the project that talks to an operating system credential
// store, and it is on the NATIVE side on purpose: `packages/core` is dependency-free
// and has no code that can persist a secret at all, so the engine cannot leak a
// keychain it cannot reach (Requirement 17.3).
//
// ── WHAT BACKS EACH PLATFORM ────────────────────────────────────────────────
//
//   Windows  Credential Manager, through `advapi32`'s `CredWriteW` / `CredReadW` /
//            `CredDeleteW`. Raw FFI rather than a crate, because `packages/core`'s
//            zero-dependency rule has made this repo's habit "hand-roll the small
//            thing", and this is about ninety lines. Generic credentials, persisted
//            for the local machine, filed under `sketch:<provider id>`.
//   macOS    Keychain, through the Security framework's generic-password API.
//   Linux    the Secret Service (GNOME Keyring, KWallet) via `secret-tool`, spawned
//            with an ARGUMENT VECTOR and NO SHELL, exactly like every other spawn in
//            this project. The secret goes in on STDIN and never appears in `argv`,
//            because `argv` is world-readable through `ps`.
//
// ── HONEST STATUS ───────────────────────────────────────────────────────────
//
// The development machine for this task is Windows and `cargo` cannot link here
// (missing GNU `dlltool`), so:
//   * the Windows FFI and the `secret-tool` backend are COMPILE-CHECKED with
//     `rustc --crate-type lib`, and the pure-std `secret-tool` argv construction is
//     unit tested;
//   * the macOS branch is not compiled on this machine at all. It is written to the
//     documented Security-framework signatures and must be exercised on a Mac before
//     anyone claims it works.
// Nothing here has been run against a real keychain yet. Do not describe it as
// verified.
//
// ── ONE INVARIANT ABOVE ALL ─────────────────────────────────────────────────
//
// No function in this file puts a secret VALUE into an error, a log, a panic message,
// or a process argument. Failures are reported with the OS's words about the failure,
// which `secret_store` then pairs with the provider id.

// The `secret-tool` backend below is compiled on every platform on purpose (see the
// note above it), so on Windows and macOS it is legitimately unused.
#![allow(dead_code)]

use crate::secret_store::CredentialBackend;

/// The backend for this build.
///
/// Returns a refusing backend rather than a silent in-memory one when no store is
/// available: a key the user believes is saved and is not is the worst outcome here,
/// so the UI must be able to say "this was not stored, and here is why".
pub fn backend() -> Box<dyn CredentialBackend + Send + Sync> {
    #[cfg(target_os = "windows")]
    {
        Box::new(windows_backend::WindowsCredentialManager)
    }
    #[cfg(target_os = "macos")]
    {
        Box::new(macos_backend::MacKeychain)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Box::new(SecretToolBackend)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    {
        Box::new(crate::secret_store::UnsupportedBackend {
            detail: "this platform has no supported credential store".to_string(),
        })
    }
}

// ── Linux / other Unix: the Secret Service through `secret-tool` ─────────────
//
// Deliberately NOT behind `#[cfg]`: it is pure `std`, so leaving it compiled on every
// platform means the Windows toolchain type-checks it too. A platform-gated module is
// a module nobody compiles until it is someone else's problem.

/// Attributes `secret-tool` files a Sketch credential under.
const ATTR_SERVICE: &str = "service";
const ATTR_ACCOUNT: &str = "account";

/// The argument vector for `secret-tool store`. A pure function, so the shape of the
/// call is testable without a keyring.
///
/// The secret is NOT here. It is written to the child's stdin, because arguments are
/// visible to any process that can read `/proc`.
pub fn secret_tool_store_args(service: &str, account: &str) -> Vec<String> {
    vec![
        "store".to_string(),
        format!("--label=Sketch API key for {}", account),
        ATTR_SERVICE.to_string(),
        service.to_string(),
        ATTR_ACCOUNT.to_string(),
        account.to_string(),
    ]
}

/// The argument vector for `secret-tool lookup` / `clear`, which share a shape.
pub fn secret_tool_query_args(verb: &str, service: &str, account: &str) -> Vec<String> {
    vec![
        verb.to_string(),
        ATTR_SERVICE.to_string(),
        service.to_string(),
        ATTR_ACCOUNT.to_string(),
        account.to_string(),
    ]
}

pub struct SecretToolBackend;

impl SecretToolBackend {
    fn run(&self, args: &[String], stdin_data: Option<&str>) -> Result<(i32, Vec<u8>), String> {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let mut child = Command::new("secret-tool")
            .args(args)
            .stdin(if stdin_data.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                format!(
                    "secret-tool could not be started ({}). Install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora/Arch) to use the system keyring.",
                    e
                )
            })?;

        if let Some(data) = stdin_data {
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| "secret-tool did not accept input".to_string())?;
            // The secret crosses this pipe and nothing else. Errors mention the pipe,
            // never its contents.
            stdin
                .write_all(data.as_bytes())
                .map_err(|e| format!("the key could not be written to secret-tool: {}", e))?;
            // Dropping closes the pipe, which is how secret-tool knows the value ended.
        }

        let output = child
            .wait_with_output()
            .map_err(|e| format!("secret-tool did not finish: {}", e))?;
        if output.status.success() {
            return Ok((0, output.stdout));
        }
        let code = output.status.code().unwrap_or(-1);
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Ok((if code == 0 { -1 } else { code }, stderr.into_bytes()))
    }
}

impl CredentialBackend for SecretToolBackend {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        let (code, out) = self.run(&secret_tool_query_args("lookup", service, account), None)?;
        if code != 0 {
            // secret-tool exits non-zero for "no such secret", which is not an error
            // here: an absent key is an answer.
            return Ok(None);
        }
        let text = String::from_utf8_lossy(&out).to_string();
        // `secret-tool lookup` does not add a newline, but a value stored by another
        // tool might carry one.
        let trimmed = text.trim_end_matches('\n').to_string();
        Ok(if trimmed.is_empty() { None } else { Some(trimmed) })
    }

    fn set(&self, service: &str, account: &str, secret: &str) -> Result<(), String> {
        let (code, out) =
            self.run(&secret_tool_store_args(service, account), Some(secret))?;
        if code != 0 {
            return Err(String::from_utf8_lossy(&out).to_string());
        }
        Ok(())
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        // `clear` on a missing secret exits non-zero; absence is the requested state,
        // so that is success.
        let _ = self.run(&secret_tool_query_args("clear", service, account), None)?;
        Ok(())
    }

    fn has(&self, service: &str, account: &str) -> Result<bool, String> {
        Ok(self.get(service, account)?.is_some())
    }

    fn describe(&self) -> String {
        "the system keyring (Secret Service)".to_string()
    }
}

// ── Windows: Credential Manager ─────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod windows_backend {
    use super::CredentialBackend;
    use std::ffi::c_void;

    const CRED_TYPE_GENERIC: u32 = 1;
    /// Persist for this OS user on this machine. Not `ENTERPRISE`: a roaming
    /// credential would sync an API key to a domain profile the user never chose.
    const CRED_PERSIST_LOCAL_MACHINE: u32 = 2;
    const ERROR_NOT_FOUND: u32 = 1168;

    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[repr(C)]
    struct CredentialW {
        flags: u32,
        cred_type: u32,
        target_name: *mut u16,
        comment: *mut u16,
        last_written: FileTime,
        credential_blob_size: u32,
        credential_blob: *mut u8,
        persist: u32,
        attribute_count: u32,
        attributes: *mut c_void,
        target_alias: *mut u16,
        user_name: *mut u16,
    }

    #[link(name = "advapi32")]
    extern "system" {
        fn CredWriteW(credential: *const CredentialW, flags: u32) -> i32;
        fn CredReadW(
            target_name: *const u16,
            cred_type: u32,
            flags: u32,
            credential: *mut *mut CredentialW,
        ) -> i32;
        fn CredDeleteW(target_name: *const u16, cred_type: u32, flags: u32) -> i32;
        fn CredFree(buffer: *mut c_void);
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetLastError() -> u32;
    }

    /// `sketch:<provider id>`, as a NUL-terminated UTF-16 buffer.
    fn target(service: &str, account: &str) -> Vec<u16> {
        format!("{}:{}", service, account)
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect()
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub struct WindowsCredentialManager;

    impl CredentialBackend for WindowsCredentialManager {
        fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
            let name = target(service, account);
            let mut raw: *mut CredentialW = std::ptr::null_mut();
            let ok = unsafe { CredReadW(name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut raw) };
            if ok == 0 {
                let code = unsafe { GetLastError() };
                if code == ERROR_NOT_FOUND {
                    return Ok(None);
                }
                return Err(format!("Windows Credential Manager returned error {}", code));
            }
            // Copy the blob out, then free the OS buffer. The copy is the only place
            // the value exists in this process, and it goes straight back to the
            // caller.
            let value = unsafe {
                let cred = &*raw;
                let bytes = std::slice::from_raw_parts(
                    cred.credential_blob,
                    cred.credential_blob_size as usize,
                );
                let text = String::from_utf8_lossy(bytes).to_string();
                CredFree(raw as *mut c_void);
                text
            };
            Ok(if value.is_empty() { None } else { Some(value) })
        }

        fn set(&self, service: &str, account: &str, secret: &str) -> Result<(), String> {
            let mut name = target(service, account);
            let mut user = wide(account);
            // `CredWriteW` copies what it is given, so a local buffer is enough — but
            // it is mutable memory the API expects to be writable.
            let mut blob = secret.as_bytes().to_vec();
            let credential = CredentialW {
                flags: 0,
                cred_type: CRED_TYPE_GENERIC,
                target_name: name.as_mut_ptr(),
                comment: std::ptr::null_mut(),
                last_written: FileTime { low: 0, high: 0 },
                credential_blob_size: blob.len() as u32,
                credential_blob: blob.as_mut_ptr(),
                persist: CRED_PERSIST_LOCAL_MACHINE,
                attribute_count: 0,
                attributes: std::ptr::null_mut(),
                target_alias: std::ptr::null_mut(),
                user_name: user.as_mut_ptr(),
            };
            let ok = unsafe { CredWriteW(&credential, 0) };
            // Wipe this process's copy of the key as soon as the OS has taken it.
            for byte in blob.iter_mut() {
                *byte = 0;
            }
            if ok == 0 {
                let code = unsafe { GetLastError() };
                return Err(format!("Windows Credential Manager returned error {}", code));
            }
            Ok(())
        }

        fn delete(&self, service: &str, account: &str) -> Result<(), String> {
            let name = target(service, account);
            let ok = unsafe { CredDeleteW(name.as_ptr(), CRED_TYPE_GENERIC, 0) };
            if ok == 0 {
                let code = unsafe { GetLastError() };
                // Already absent is the requested state.
                if code == ERROR_NOT_FOUND {
                    return Ok(());
                }
                return Err(format!("Windows Credential Manager returned error {}", code));
            }
            Ok(())
        }

        fn has(&self, service: &str, account: &str) -> Result<bool, String> {
            Ok(self.get(service, account)?.is_some())
        }

        fn describe(&self) -> String {
            "Windows Credential Manager".to_string()
        }
    }
}

// ── macOS: the Keychain ─────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos_backend {
    use super::CredentialBackend;
    use std::ffi::c_void;
    use std::os::raw::c_char;

    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    const ERR_SEC_DUPLICATE_ITEM: i32 = -25299;

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecKeychainAddGenericPassword(
            keychain: *mut c_void,
            service_name_length: u32,
            service_name: *const c_char,
            account_name_length: u32,
            account_name: *const c_char,
            password_length: u32,
            password_data: *const c_void,
            item_ref: *mut *mut c_void,
        ) -> i32;
        fn SecKeychainFindGenericPassword(
            keychain_or_array: *const c_void,
            service_name_length: u32,
            service_name: *const c_char,
            account_name_length: u32,
            account_name: *const c_char,
            password_length: *mut u32,
            password_data: *mut *mut c_void,
            item_ref: *mut *mut c_void,
        ) -> i32;
        fn SecKeychainItemModifyAttributesAndData(
            item_ref: *mut c_void,
            attr_list: *const c_void,
            length: u32,
            data: *const c_void,
        ) -> i32;
        fn SecKeychainItemDelete(item_ref: *mut c_void) -> i32;
        fn SecKeychainItemFreeContent(attr_list: *mut c_void, data: *mut c_void) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *mut c_void);
    }

    pub struct MacKeychain;

    /// Find the item, returning its ref and (optionally) its password.
    fn find(
        service: &str,
        account: &str,
        want_password: bool,
    ) -> Result<Option<(*mut c_void, Option<String>)>, String> {
        let mut length: u32 = 0;
        let mut data: *mut c_void = std::ptr::null_mut();
        let mut item: *mut c_void = std::ptr::null_mut();
        let status = unsafe {
            SecKeychainFindGenericPassword(
                std::ptr::null(),
                service.len() as u32,
                service.as_ptr() as *const c_char,
                account.len() as u32,
                account.as_ptr() as *const c_char,
                if want_password { &mut length } else { std::ptr::null_mut() },
                if want_password { &mut data } else { std::ptr::null_mut() },
                &mut item,
            )
        };
        if status == ERR_SEC_ITEM_NOT_FOUND {
            return Ok(None);
        }
        if status != 0 {
            return Err(format!("the macOS Keychain returned status {}", status));
        }
        let password = if want_password && !data.is_null() {
            let bytes = unsafe { std::slice::from_raw_parts(data as *const u8, length as usize) };
            let text = String::from_utf8_lossy(bytes).to_string();
            unsafe { SecKeychainItemFreeContent(std::ptr::null_mut(), data) };
            Some(text)
        } else {
            None
        };
        Ok(Some((item, password)))
    }

    impl CredentialBackend for MacKeychain {
        fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
            match find(service, account, true)? {
                None => Ok(None),
                Some((item, password)) => {
                    if !item.is_null() {
                        unsafe { CFRelease(item) };
                    }
                    Ok(password.filter(|value| !value.is_empty()))
                }
            }
        }

        fn set(&self, service: &str, account: &str, secret: &str) -> Result<(), String> {
            // An existing item is UPDATED rather than duplicated: two keychain items
            // with the same service and account is how a stale key keeps being used.
            if let Some((item, _)) = find(service, account, false)? {
                let status = unsafe {
                    SecKeychainItemModifyAttributesAndData(
                        item,
                        std::ptr::null(),
                        secret.len() as u32,
                        secret.as_ptr() as *const c_void,
                    )
                };
                if !item.is_null() {
                    unsafe { CFRelease(item) };
                }
                if status != 0 {
                    return Err(format!("the macOS Keychain returned status {}", status));
                }
                return Ok(());
            }

            let mut item: *mut c_void = std::ptr::null_mut();
            let status = unsafe {
                SecKeychainAddGenericPassword(
                    std::ptr::null_mut(),
                    service.len() as u32,
                    service.as_ptr() as *const c_char,
                    account.len() as u32,
                    account.as_ptr() as *const c_char,
                    secret.len() as u32,
                    secret.as_ptr() as *const c_void,
                    &mut item,
                )
            };
            if !item.is_null() {
                unsafe { CFRelease(item) };
            }
            if status == ERR_SEC_DUPLICATE_ITEM {
                return Err("the macOS Keychain already holds an entry for this provider that could not be updated".to_string());
            }
            if status != 0 {
                return Err(format!("the macOS Keychain returned status {}", status));
            }
            Ok(())
        }

        fn delete(&self, service: &str, account: &str) -> Result<(), String> {
            match find(service, account, false)? {
                // Already absent is the requested state.
                None => Ok(()),
                Some((item, _)) => {
                    let status = unsafe { SecKeychainItemDelete(item) };
                    if !item.is_null() {
                        unsafe { CFRelease(item) };
                    }
                    if status != 0 && status != ERR_SEC_ITEM_NOT_FOUND {
                        return Err(format!("the macOS Keychain returned status {}", status));
                    }
                    Ok(())
                }
            }
        }

        fn has(&self, service: &str, account: &str) -> Result<bool, String> {
            Ok(find(service, account, false)?.is_some())
        }

        fn describe(&self) -> String {
            "the macOS Keychain".to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_secret_never_appears_in_an_argument_vector() {
        const KEY: &str = "sk-ant-api03-DEADBEEFdeadbeef0123456789abcdefghij";
        let store = secret_tool_store_args("sketch", "openai");
        for arg in &store {
            assert!(!arg.contains(KEY), "{}", arg);
        }
        // Attributes are named pairs, and the label names the provider, not the key.
        assert_eq!(store[0], "store");
        assert!(store.contains(&"service".to_string()));
        assert!(store.contains(&"openai".to_string()));

        let lookup = secret_tool_query_args("lookup", "sketch", "openai");
        assert_eq!(lookup[0], "lookup");
        assert_eq!(lookup.len(), 5);
        let clear = secret_tool_query_args("clear", "sketch", "openai");
        assert_eq!(clear[0], "clear");
    }
}
