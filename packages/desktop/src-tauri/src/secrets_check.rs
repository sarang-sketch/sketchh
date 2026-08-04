// Verification shim, not part of the app.
//
// `cargo test` cannot link on the development machine for this task (missing GNU
// `dlltool`), and `os_credentials.rs` refers to `crate::secret_store`, so neither file
// compiles alone. This crate root declares both as one crate so they can be checked
// and tested without a Tauri toolchain and without a linker:
//
//   rustc --crate-type lib src/secrets_check.rs -o <tmp>/check.rlib     # type check
//   rustc --test src/secrets_check.rs -o <tmp>/check && <tmp>/check     # run tests
//
// It is NOT referenced by main.rs, and `[[bin]]` names only `src/main.rs`, so it is
// excluded from the binary.
//
// The probes below mirror the BODIES of the three `#[tauri::command]` functions in
// main.rs. main.rs itself cannot be compiled here (it needs the Tauri crates, which
// need a linker), so without these the command bodies would be entirely unchecked —
// which is how a trait-object coercion or a borrow that does not compile reaches a
// commit. If a command body changes, change its probe.

pub mod os_credentials;
pub mod secret_store;

/// Mirrors `list_providers`.
pub fn probe_list(provider_ids: Vec<String>) -> Result<Vec<(String, bool, String)>, String> {
    let backend = os_credentials::backend();
    let store = backend.describe();
    secret_store::list_presence(backend.as_ref(), &provider_ids)
        .map(|rows| {
            rows.into_iter()
                .map(|row| (row.id, row.has_key, store.clone()))
                .collect()
        })
        .map_err(|e| e.to_string())
}

/// Mirrors `set_api_key`.
pub fn probe_set(provider_id: String, api_key: String) -> Result<String, String> {
    let backend = os_credentials::backend();
    secret_store::set_secret(backend.as_ref(), &provider_id, &api_key)
        .map(|()| backend.describe())
        .map_err(|e| e.to_string())
}

/// Mirrors `resolve_api_key`.
pub fn probe_resolve(provider_id: String) -> Result<Option<String>, String> {
    let backend = os_credentials::backend();
    secret_store::resolve_secret(backend.as_ref(), &provider_id).map_err(|e| e.to_string())
}

/// Mirrors `remove_api_key`.
pub fn probe_remove(provider_id: String) -> Result<String, String> {
    let backend = os_credentials::backend();
    secret_store::remove_secret(backend.as_ref(), &provider_id)
        .map(|()| backend.describe())
        .map_err(|e| e.to_string())
}
