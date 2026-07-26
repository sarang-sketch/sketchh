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
