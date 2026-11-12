// The window's side of a real terminal: start a shell in a pseudo-terminal, type into
// it, resize it, end it. The Rust side is src-tauri/src/terminal_ipc.rs over the
// `sketch-terminal` crate.
//
// A seam, not a module that calls Tauri directly: the session manager takes a
// `PtyBackend`, so the tests drive it with a scripted backend and the app hands it the
// real one. Outside the desktop shell (the browser dev bridge) there is no backend at
// all and the terminal panel keeps its classic command runner.

import { isDesktopShell } from '../lib/desktopGuards'

/** A shell installed on this machine, as the backend detected it. */
export interface ShellProfile {
  /** Stable: "pwsh", "powershell", "cmd", "git-bash", "wsl:Ubuntu", "zsh"… */
  id: string
  /** For the menu: "PowerShell", "Git Bash", "Ubuntu (WSL)". */
  name: string
  program: string
  args: string[]
  /** powershell, cmd, bash, zsh, fish, nu, wsl, sh. */
  family: string
}

/** What a session reports, in order: output, then exactly one exit. */
export type PtyEvent = { kind: 'data'; data: string } | { kind: 'exit'; code: number | null }

export interface PtyOpened {
  id: number
  pid: number | null
  profile: ShellProfile
  /** The folder the shell started in. */
  cwd: string
  /** Windows only: lets the emulator handle this build's ConPTY behaviour. */
  windowsBuild: number | null
}

export interface PtyOpenParams {
  projectRoot: string
  /** Absolute, inside the project. Absent: the project root. */
  cwd?: string | null
  /** Absent: this machine's default shell. */
  profileId?: string | null
  cols: number
  rows: number
  /** Called for every event, possibly before `open` resolves. */
  onEvent: (event: PtyEvent) => void
}

export interface PtyBackend {
  profiles(refresh?: boolean): Promise<ShellProfile[]>
  open(params: PtyOpenParams): Promise<PtyOpened>
  write(id: number, data: string): Promise<void>
  resize(id: number, cols: number, rows: number): Promise<void>
  close(id: number): Promise<boolean>
}

/** A rejected Tauri command arrives as a bare string; make it an Error with that text. */
function asError(err: unknown): Error {
  if (err instanceof Error) return err
  return new Error(typeof err === 'string' ? err : 'The terminal backend did not answer.')
}

/** The desktop app's backend, or null outside the Tauri shell. */
export function tauriPtyBackend(): PtyBackend | null {
  if (!isDesktopShell()) return null
  const core = () => import('@tauri-apps/api/core')
  return {
    async profiles(refresh = false) {
      const { invoke } = await core()
      try {
        return await invoke<ShellProfile[]>('terminal_profiles', { refresh })
      } catch (err) {
        throw asError(err)
      }
    },
    async open(params) {
      const { Channel, invoke } = await core()
      // Tauri's channel is ordered: output arrives in order, then the exit.
      const channel = new Channel<PtyEvent>()
      channel.onmessage = (event) => params.onEvent(event)
      try {
        return await invoke<PtyOpened>('terminal_open', {
          projectRoot: params.projectRoot,
          cwd: params.cwd ?? null,
          profileId: params.profileId ?? null,
          cols: Math.max(2, Math.floor(params.cols)),
          rows: Math.max(1, Math.floor(params.rows)),
          // The panel asked the person before the first shell in this folder.
          confirmed: true,
          onEvent: channel,
        })
      } catch (err) {
        throw asError(err)
      }
    },
    async write(id, data) {
      const { invoke } = await core()
      try {
        await invoke('terminal_write', { id, data })
      } catch (err) {
        throw asError(err)
      }
    },
    async resize(id, cols, rows) {
      const { invoke } = await core()
      try {
        await invoke('terminal_resize', { id, cols: Math.max(2, Math.floor(cols)), rows: Math.max(1, Math.floor(rows)) })
      } catch (err) {
        throw asError(err)
      }
    },
    async close(id) {
      const { invoke } = await core()
      try {
        return await invoke<boolean>('terminal_close', { id })
      } catch (err) {
        throw asError(err)
      }
    },
  }
}
