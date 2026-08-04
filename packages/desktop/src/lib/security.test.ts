// Structural guards on the Tauri surface: what is exposed to the webview, and what
// the terminal tool is allowed to start.
//
// These read configuration and Rust source as text on purpose. The Rust behaviour
// itself is covered by unit tests in src-tauri/src/command_policy.rs; this file is
// the tripwire that catches the config drifting back to a wide-open state without
// needing a cargo toolchain.
//
// Validates: Requirements 13.4, 13.8, 22.6

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Phase 1.5 — Tauri Security Hardening', () => {
  const tauriDir = path.resolve(__dirname, '../../src-tauri');
  const confPath = path.join(tauriDir, 'tauri.conf.json');
  const capPath = path.join(tauriDir, 'capabilities/default.json');
  const cargoPath = path.join(tauriDir, 'Cargo.toml');
  const mainRsPath = path.join(tauriDir, 'src/main.rs');

  it('proves tauri.conf.json has non-null CSP and scoped fs permissions', () => {
    expect(fs.existsSync(confPath)).toBe(true);
    const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));

    expect(conf.app.security.csp).not.toBeNull();
    expect(typeof conf.app.security.csp).toBe('string');
    expect(conf.app.security.csp).toContain("default-src 'self'");

    expect(conf.plugins.fs.scope).not.toContain('**');
    expect(conf.plugins.shell.scope).toHaveLength(0);
  });

  it('proves src-tauri/capabilities/default.json exists with explicit permissions', () => {
    expect(fs.existsSync(capPath)).toBe(true);
    const cap = JSON.parse(fs.readFileSync(capPath, 'utf8'));

    expect(cap.identifier).toBe('default');
    expect(cap.windows).toContain('main');
    expect(cap.permissions).toContain('core:default');
    expect(cap.permissions).toContain('dialog:default');
    expect(cap.permissions).toContain('fs:default');
  });

  it('proves Cargo.toml includes tauri-plugin-dialog dependency', () => {
    expect(fs.existsSync(cargoPath)).toBe(true);
    const cargoStr = fs.readFileSync(cargoPath, 'utf8');
    expect(cargoStr).toContain('tauri-plugin-dialog');
  });

  it('proves main.rs implements open_project_dialog', () => {
    expect(fs.existsSync(mainRsPath)).toBe(true);
    const mainRs = fs.readFileSync(mainRsPath, 'utf8');

    expect(mainRs).toContain('tauri_plugin_dialog::init()');
    expect(mainRs).toContain('open_project_dialog');
    expect(mainRs).toContain('blocking_pick_folder');
  });
});

describe('Phase 2 — the engine sidecar is registered, and only the engine', () => {
  const tauriDir = path.resolve(__dirname, '../../src-tauri');
  const conf = JSON.parse(fs.readFileSync(path.join(tauriDir, 'tauri.conf.json'), 'utf8'));
  const cap = JSON.parse(fs.readFileSync(path.join(tauriDir, 'capabilities/default.json'), 'utf8'));

  it('registers the engine bundle as an externalBin sidecar', () => {
    // Tauri appends -<target-triple> to this name at bundle time; the build script
    // (scripts/build-sidecar.mjs) writes the file under exactly that name.
    expect(conf.bundle.externalBin).toContain('binaries/sketch-engine');
    expect(conf.bundle.resources).toContain('resources/sketch-engine.mjs');
  });

  it('has the Tauri build produce the sidecar before it builds the app', () => {
    expect(conf.build.beforeBuildCommand).toContain('build:sidecar');
    expect(conf.build.beforeDevCommand).toContain('build:sidecar');
  });

  it('grants spawn permission to that one sidecar and not to the shell at large', () => {
    const spawnGrant = cap.permissions.find(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { identifier?: string }).identifier === 'shell:allow-spawn',
    ) as { allow: Array<{ name: string; sidecar: boolean }> };

    expect(spawnGrant).toBeDefined();
    expect(spawnGrant.allow).toHaveLength(1);
    expect(spawnGrant.allow[0]!.name).toBe('binaries/sketch-engine');
    expect(spawnGrant.allow[0]!.sidecar).toBe(true);

    // A bare string grant would be unscoped: any command, any arguments.
    expect(cap.permissions).not.toContain('shell:allow-spawn');
    expect(cap.permissions).not.toContain('shell:allow-execute');
    expect(conf.plugins.shell.scope).toHaveLength(0);
  });
});

describe('Requirement 22.6 — run_command is an allowlist, not a shell', () => {
  const tauriDir = path.resolve(__dirname, '../../src-tauri');
  const mainRs = fs.readFileSync(path.join(tauriDir, 'src/main.rs'), 'utf8');
  const policyRs = fs.readFileSync(path.join(tauriDir, 'src/command_policy.rs'), 'utf8');

  it('no longer passes a command string to a shell', () => {
    expect(mainRs).not.toContain('"/C"');
    expect(mainRs).not.toContain('"-c"');
    expect(mainRs).not.toContain('Command::new("sh")');
    expect(mainRs).not.toContain('Command::new("cmd")');
  });

  it('no longer relies on a substring denylist', () => {
    expect(mainRs).not.toContain('forbidden_patterns');
    expect(mainRs).not.toContain('restricted pattern');
    expect(policyRs).not.toContain('forbidden_patterns');
  });

  it('takes a program plus an argument vector', () => {
    expect(mainRs).toMatch(/program:\s*String/);
    expect(mainRs).toMatch(/args:\s*Vec<String>/);
    expect(mainRs).toMatch(/confirmed:\s*bool/);
  });

  it('checks the allowlist, the confirmation, and cwd containment before spawning', () => {
    expect(mainRs).toContain('command_policy::require_confirmation');
    expect(mainRs).toContain('command_policy::resolve_program');
    expect(mainRs).toContain('command_policy::resolve_cwd');
    expect(policyRs).toContain('ALLOWED_PROGRAMS');
    expect(policyRs).toContain('outside the open project root');
  });

  it('keeps the allowlist small and free of shells', () => {
    const list = /pub const ALLOWED_PROGRAMS: &\[&str\] = &\[([^\]]+)\]/.exec(policyRs);
    expect(list).not.toBeNull();
    const programs = list![1]!
      .split(',')
      .map((entry) => entry.trim().replace(/"/g, ''))
      .filter((entry) => entry !== '');

    expect(programs.length).toBeLessThanOrEqual(8);
    for (const shell of ['sh', 'bash', 'zsh', 'cmd', 'powershell', 'pwsh', 'npx']) {
      expect(programs).not.toContain(shell);
    }
    expect(programs).toContain('git');
  });
});

describe('the terminal caller passes a vector, not a line', () => {
  const bridge = fs.readFileSync(path.resolve(__dirname, '../ipc/bridge.ts'), 'utf8');

  it('sends program, args, projectRoot and confirmed', () => {
    expect(bridge).toContain("invoke<CommandOutput>('run_command'");
    expect(bridge).toContain('program: request.program');
    expect(bridge).toContain('args: request.args ?? []');
    expect(bridge).toContain('projectRoot: request.projectRoot');
    expect(bridge).toContain('confirmed: request.confirmed');
  });

  it('has no single-string command parameter left', () => {
    expect(bridge).not.toMatch(/runCommand\(cwd: string, command: string\)/);
  });
});

describe('Requirement 13.8 — the file commands are contained, not scope-shaped', () => {
  const tauriDir = path.resolve(__dirname, '../../src-tauri');
  const mainRs = fs.readFileSync(path.join(tauriDir, 'src/main.rs'), 'utf8');
  const policyRs = fs.readFileSync(path.join(tauriDir, 'src/command_policy.rs'), 'utf8');

  /** The body of one `#[tauri::command] fn NAME(...) { ... }`, up to the next command. */
  function commandBody(name: string): string {
    const start = mainRs.indexOf(`fn ${name}(`);
    expect(start, `${name} is not defined in main.rs`).toBeGreaterThan(-1);
    const rest = mainRs.slice(start);
    const next = rest.indexOf('#[tauri::command]');
    return next === -1 ? rest : rest.slice(0, next);
  }

  it('takes a project_root on every command that touches a path', () => {
    for (const command of ['read_dir', 'read_file', 'write_file']) {
      expect(commandBody(command)).toMatch(/project_root:\s*String/);
    }
  });

  it('resolves every path through command_policy before touching the disk', () => {
    // The check is per command, not per file: a containment call somewhere in main.rs
    // says nothing about whether THIS command uses it.
    expect(commandBody('read_dir')).toContain('command_policy::resolve_dir_within');
    expect(commandBody('read_file')).toContain('command_policy::resolve_file_within');
    expect(commandBody('write_file')).toContain('command_policy::resolve_write_target');

    // And none of them still hands a caller-supplied path straight to std::fs.
    for (const command of ['read_dir', 'read_file', 'write_file']) {
      const body = commandBody(command);
      expect(body).not.toMatch(/fs::read_to_string\(&path\)/);
      expect(body).not.toMatch(/fs::write\(&path/);
      expect(body).not.toMatch(/fs::read_dir\(&PathBuf::from/);
      expect(body).not.toMatch(/create_dir_all\(parent\).*PathBuf::from\(&path\)/s);
    }
  });

  it('keeps one containment implementation, shared with the terminal cwd', () => {
    // resolve_cwd delegates rather than carrying a second prefix test.
    const cwd = /pub fn resolve_cwd[\s\S]*?\r?\n}/.exec(policyRs);
    expect(cwd).not.toBeNull();
    expect(cwd![0]).toContain('resolve_within');
    expect(cwd![0]).not.toContain('starts_with');

    // Exactly one place performs the prefix comparison.
    expect(policyRs.match(/fn is_within/g)).toHaveLength(1);
    expect(policyRs.match(/candidate\.starts_with\(root\)/g)).toHaveLength(1);
    // And it is reached by canonical paths on both sides, which is what defeats
    // symlinks and `..` alike.
    expect(policyRs).toContain('canonicalize');
  });

  it('the write path resolves a target that does not exist yet', () => {
    // `\r?\n` throughout: this repo is checked out with CRLF on Windows, and a
    // guard that only matches LF would pass or fail by platform rather than by code.
    const write = /pub fn resolve_write_target[\s\S]*?\r?\n}/.exec(policyRs);
    expect(write).not.toBeNull();
    // Existence is established with symlink_metadata, so a dangling link is not
    // mistaken for a missing segment and followed out of the project.
    expect(write![0]).toContain('symlink_metadata');
    // The `..` refusal is not restated here: the write path reaches it through the
    // same `absolutize` the read path uses, and that is the point — one rejection of
    // `..`, applied everywhere, rather than a copy per command that can drift.
    expect(write![0]).toContain('absolutize');
    const absolutize = /fn absolutize[\s\S]*?\r?\n}/.exec(policyRs);
    expect(absolutize).not.toBeNull();
    expect(absolutize![0]).toContain('has_parent_escape');
    expect(policyRs.match(/fn has_parent_escape/g)).toHaveLength(1);
    // And the containment prefix test still applies to the anchor it resolved.
    expect(write![0]).toContain('is_within(&root, &anchor)');
  });

  it('the frontend passes projectRoot on every file call', () => {
    const bridge = fs.readFileSync(path.resolve(__dirname, '../ipc/bridge.ts'), 'utf8');
    expect(bridge).toContain("invoke<FsEntry[]>('read_dir', { projectRoot, path })");
    expect(bridge).toContain("invoke<string>('read_file', { projectRoot, path })");
    expect(bridge).toContain("invoke<void>('write_file', { projectRoot, path, content })");
  });
});

describe('the IPC bridge is one seam, for OS capabilities only', () => {
  const bridge = fs.readFileSync(path.resolve(__dirname, '../ipc/bridge.ts'), 'utf8');
  const mainRs = fs.readFileSync(
    path.resolve(__dirname, '../../src-tauri/src/main.rs'),
    'utf8',
  );

  /**
   * The bridge with its comments removed.
   *
   * The "this is gone" assertions below have to read CODE, not prose. bridge.ts
   * documents what it used to carry and why (`list_providers`, `null as T`, …), and a
   * raw-text check cannot tell an explanation of a removal from the removal itself —
   * it would fail on the very comment that records the fix.
   */
  const bridgeCode = bridge
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  it('names only commands that exist in main.rs', () => {
    const invoked = [...bridgeCode.matchAll(/invoke<[^>]*>\('([a-z_]+)'/g)].map((m) => m[1]!);
    expect(invoked.length).toBeGreaterThan(0);
    for (const command of invoked) {
      // The generic parameter list on `open_project_dialog<R: tauri::Runtime>` sits
      // between the name and the argument list, so it has to be tolerated here.
      expect(mainRs, `bridge.ts invokes '${command}'`).toMatch(
        new RegExp(`fn ${command}(<[^>]*>)?\\s*\\(`),
      );
      expect(mainRs, `${command} is not registered`).toMatch(
        new RegExp(`generate_handler!\\[[\\s\\S]*?${command},`),
      );
    }
  });

  it('carries no wrapper for a command Rust never had', () => {
    // `list_providers`, `set_api_key` and `remove_api_key` were on this list until
    // task 4.2 implemented them in Rust. They came off it because they now EXIST —
    // which the test above proves, per command, against main.rs. Nothing was relaxed:
    // the rule is still "no wrapper without an implementation", and these three are
    // additionally covered by the credential guards below.
    for (const phantom of ['run_task', 'approve_plan', 'cancel_task']) {
      expect(bridgeCode, `${phantom} is wrapped`).not.toContain(phantom);
    }
    // Nor listeners for events nothing emits.
    expect(bridgeCode).not.toContain('task-event');
    expect(bridgeCode).not.toContain('file-changed');
  });

  it('points engine RPC at SketchClient and fails loudly outside Tauri', () => {
    expect(bridge).toContain('SketchClient');
    // A silent `null as T` fallback in the invoke wrapper, not the note explaining
    // why one is not there.
    expect(bridgeCode).not.toContain('null as T');
    expect(bridgeCode).toContain('not running under Tauri');
  });
});

describe('Requirements 17.3, 17.4 — secrets live in the OS store and never come back', () => {
  const tauriDir = path.resolve(__dirname, '../../src-tauri');
  const mainRs = fs.readFileSync(path.join(tauriDir, 'src/main.rs'), 'utf8');
  const policyRs = fs.readFileSync(path.join(tauriDir, 'src/command_policy.rs'), 'utf8');
  const secretRs = fs.readFileSync(path.join(tauriDir, 'src/secret_store.rs'), 'utf8');
  const osRs = fs.readFileSync(path.join(tauriDir, 'src/os_credentials.rs'), 'utf8');

  /** Rust with its comments stripped: these files DOCUMENT what they refuse to do. */
  const rustCode = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  const CREDENTIAL_COMMANDS = [
    'list_providers',
    'set_api_key',
    'resolve_api_key',
    'remove_api_key',
  ];

  it('registers exactly the four credential commands and no others', () => {
    for (const command of CREDENTIAL_COMMANDS) {
      expect(mainRs, `${command} is not defined`).toMatch(new RegExp(`fn ${command}\\s*\\(`));
      expect(mainRs, `${command} is not registered`).toMatch(
        new RegExp(`generate_handler!\\[[\\s\\S]*?${command},`),
      );
    }
    // The inventory is closed. A fifth secret-shaped command must be a deliberate edit
    // to this list, not something that arrives alongside an unrelated change.
    const declared = [...rustCode(mainRs).matchAll(/fn (\w*(?:api_key|providers|secret)\w*)\s*\(/g)]
      .map((match) => match[1]!)
      .sort();
    expect(declared).toEqual([...CREDENTIAL_COMMANDS].sort());
  });

  it('returns a key value from exactly one command, for one id, and never a preview', () => {
    const code = rustCode(mainRs);

    // `resolve_api_key` is the one exception, and it exists because Requirement 17.4
    // needs a key at invocation time — a store nothing can read made every stored key
    // useless. What stays forbidden is everything that was never necessary for that:
    // a preview, a truncation, a "reveal", or a bulk read.
    for (const forbidden of [
      'fn get_api_key',
      'fn read_api_key',
      'fn reveal',
      'key_prefix',
      'last_four',
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }

    // ONE ID IN, ONE OPTIONAL VALUE OUT. A `Vec<String>` argument or a collection return
    // would be enumeration of the user's keychain, which nothing here may do.
    const resolve = /fn resolve_api_key\s*\(([\s\S]*?)\)\s*->\s*([^{]+)\{/.exec(mainRs);
    expect(resolve).not.toBeNull();
    expect(resolve![1]!.trim()).toBe('provider_id: String');
    expect(resolve![2]!.trim()).toBe('Result<Option<String>, String>');
    expect(resolve![1]).not.toContain('Vec');

    // Only `resolve_api_key` may return a secret value at all.
    for (const command of CREDENTIAL_COMMANDS.filter((name) => name !== 'resolve_api_key')) {
      const signature = new RegExp(`fn ${command}\\s*\\([\\s\\S]*?\\)\\s*->\\s*([^{]+)\\{`).exec(mainRs);
      expect(signature, command).not.toBeNull();
      expect(signature![1], command).not.toContain('Option<String>');
    }

    // The presence shape is an id, a bool and the store's NAME — no fourth field. The
    // settings surface still cannot reach a value.
    const presence = /struct ProviderKeyPresence \{[\s\S]*?\n\}/.exec(mainRs);
    expect(presence).not.toBeNull();
    expect(presence![0]).toContain('has_key: bool');
    for (const forbidden of ['api_key', 'secret', 'value', 'preview']) {
      expect(presence![0], forbidden).not.toContain(forbidden);
    }
  });

  it('keeps the resolved key out of application state and out of any log', () => {
    const secretsTs = fs.readFileSync(path.resolve(__dirname, 'secrets.ts'), 'utf8');
    const seam = secretsTs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

    // The value's whole lifetime is one local and one outgoing request. Any of these
    // would extend it: a module cache, a dispatch into the store, or a console line.
    for (const forbidden of ['useState', 'localStorage', 'sessionStorage', 'dispatch(', 'console.']) {
      expect(seam, forbidden).not.toContain(forbidden);
    }
    // No module-level mutable holder either.
    expect(seam).not.toMatch(/^(let|var)\s/m);

    // The engine redacts it on arrival, which is what makes the run request a safe
    // carrier. If that call ever goes, a key can reach an event log.
    const methods = fs.readFileSync(
      path.resolve(__dirname, '../../../core/src/rpc/methods.ts'),
      'utf8',
    );
    expect(methods).toContain('ctx.rememberSecret(apiKey)');
  });

  it('holds no key in application state', () => {
    const code = rustCode(mainRs);
    // The commands are stateless: a backend per call, dropped when it returns. A
    // long-lived map of keys is the thing this asserts is absent.
    expect(code).not.toMatch(/State<[^>]*Secret/);
    expect(code).not.toMatch(/Mutex<[^>]*(HashMap|BTreeMap)<String, String>/);
    expect(code).toContain('os_credentials::backend()');
  });

  it('keeps storage in the OS credential store, and no file fallback anywhere near it', () => {
    // A "temporary" file fallback is how a key ends up in plaintext on disk forever.
    for (const source of [secretRs, osRs]) {
      const code = rustCode(source);
      expect(code).not.toContain('fs::write');
      expect(code).not.toContain('fs::read_to_string');
      expect(code).not.toContain('File::create');
    }
    // The real backends, one per platform.
    expect(osRs).toContain('CredWriteW');
    expect(osRs).toContain('SecKeychainAddGenericPassword');
    expect(osRs).toContain('secret-tool');
    // And the Linux path never puts the secret in argv, where `ps` can read it.
    expect(osRs).toContain('Stdio::piped()');
    const storeArgs = /pub fn secret_tool_store_args\(([\s\S]*?)\)[\s\S]*?\r?\n}/.exec(osRs);
    expect(storeArgs).not.toBeNull();
    // The builder is not even GIVEN the secret: two parameters, both non-secret.
    expect(storeArgs![1]!.trim()).toBe('service: &str, account: &str');
    expect(rustCode(storeArgs![0]!)).not.toContain('secret.');
  });

  it('adds no second containment primitive, and takes no path', () => {
    // Task 4.2's commands address a credential record, not the filesystem, so there is
    // nothing here to contain — and containment stays where it is: exactly one
    // `is_within` and one `has_parent_escape`, both in command_policy.rs.
    expect(policyRs.match(/fn is_within/g)).toHaveLength(1);
    expect(policyRs.match(/fn has_parent_escape/g)).toHaveLength(1);
    for (const source of [secretRs, rustCode(osRs)]) {
      expect(source).not.toContain('fn is_within');
      expect(source).not.toContain('fn has_parent_escape');
    }
    expect(rustCode(secretRs)).not.toContain('canonicalize');

    // No credential command takes a path-shaped argument.
    for (const command of CREDENTIAL_COMMANDS) {
      const signature = new RegExp(`fn ${command}\\s*\\(([\\s\\S]*?)\\)`).exec(mainRs);
      expect(signature, command).not.toBeNull();
      for (const forbidden of ['path', 'project_root', 'cwd', 'PathBuf']) {
        expect(signature![1], `${command} takes a ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('validates the provider id the same way the engine does', () => {
    // The engine's rule is SECRET_ID_PATTERN in packages/core/src/secrets/store.ts.
    // Two validators that disagree means one of them is the weak one.
    const core = fs.readFileSync(
      path.resolve(__dirname, '../../../core/src/secrets/store.ts'),
      'utf8',
    );
    const pattern = /export const SECRET_ID_PATTERN = (.+)/.exec(core);
    expect(pattern).not.toBeNull();
    expect(pattern![1]).toContain('A-Za-z0-9._-');
    expect(pattern![1]).toContain('127');

    const validate = /pub fn validate_id[\s\S]*?\n}/.exec(secretRs);
    expect(validate).not.toBeNull();
    expect(validate![0]).toContain('is_ascii_alphanumeric');
    expect(validate![0]).toContain("c == '.'");
    expect(validate![0]).toContain('MAX_ID_LEN');
    expect(secretRs).toContain('pub const MAX_ID_LEN: usize = 128;');
  });

  it('has an error type with no room for a secret', () => {
    const enumBody = /pub enum SecretError \{[\s\S]*?\n\}/.exec(secretRs);
    expect(enumBody).not.toBeNull();
    // Every variant carries an id, an operation, a byte count, or the OS's own words
    // about a FAILURE. None carries the value that was being written.
    for (const forbidden of ['secret:', 'value:', 'api_key', 'blob']) {
      expect(enumBody![0], forbidden).not.toContain(forbidden);
    }
  });
});

describe('Requirement 13.8 — the dev bridge answers loopback and same origin only', () => {
  const viteConfig = fs.readFileSync(path.resolve(__dirname, '../../vite.config.ts'), 'utf8');

  it('checks Host and Origin before dispatching either endpoint', () => {
    expect(viteConfig).toContain('function refusalReason');
    expect(viteConfig).toContain('req.headers.origin');
    expect(viteConfig).toContain('req.headers.host');
    expect(viteConfig).toContain('isLoopback');
    // The guard runs for bridge paths before the endpoint handlers.
    expect(viteConfig).toMatch(/if \(isBridgePath\)[\s\S]{0,200}refusalReason\(req\)/);
  });
});
