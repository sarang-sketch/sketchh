// The Goldfish context: exactly what a fresh reviewer is allowed to see.
//
// EGM's rule is that a Goldfish reviewer examines the draft and its referenced
// source material with NO prior conversation. Sketch has no isolated subagent
// contexts yet, so the fresh-eyes property is provided by a fresh review
// session — a run started with an empty history — and by this module, which
// builds the one thing that session may read: the target document plus the
// files it links to. There is deliberately no field for chat history anywhere
// in the result type: a context built here cannot carry prior turns, because
// there is nowhere to put them. The panel shows this list before a review
// runs, so the user can see what the reviewers will — and will not — see.
//
// Link resolution follows EGM's review intake (Step 1.3): anchor-only links
// are skipped, `#fragment`s are stripped, relative links resolve against the
// document's folder, and anything that lands outside the project — or is a
// URL — is listed as excluded and left out, never silently included.
//
// Validates: EGM Goldfish fresh-context rule (adapted).

import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** One file the reviewers may read: project-relative path plus its bytes. */
export interface GoldfishFile {
  /** Project-relative POSIX path. */
  path: string
  content: string
}

/** A link the document makes that the reviewers will NOT see, and why. */
export interface ExcludedLink {
  /** The link exactly as written in the document. */
  link: string
  reason: 'anchor-only' | 'url' | 'outside-project' | 'missing'
}

export interface GoldfishContext {
  /** The document under review. */
  target: GoldfishFile
  /** The linked files inside the project, target excluded, sorted by path. */
  files: GoldfishFile[]
  /** Links left out, with the reason each was left out. */
  excluded: ExcludedLink[]
  /** Always 0. This context never carries chat history; the type has no field
   * for it, so a caller cannot smuggle turns in. */
  priorChatTurns: 0
  /** What the reviewers were told they are: fresh eyes, no prior conversation. */
  note: string
}

export type BuildGoldfishContextResult =
  | { ok: true; context: GoldfishContext }
  | { ok: false; error: string }

export interface BuildGoldfishContextOptions {
  /** The project root. Nothing outside it is ever read. */
  projectRoot: string
  /** Path to the document under review, absolute or relative to the root. */
  targetFile: string
  /** Extra context files (a GoldfishContext reading list), project-relative or absolute. */
  extraContext?: readonly string[]
  /** Overridable for tests; defaults to reading from disk. */
  read?: (path: string) => Promise<string>
}

const defaultRead = (path: string): Promise<string> => readFile(path, 'utf8')

/** True when `child` stays inside `parent` after both are resolved. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

/** Markdown inline links `[text](destination)` in a document. */
export function extractMarkdownLinks(markdown: string): string[] {
  const links: string[] = []
  const pattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(markdown)) !== null) {
    const destination = match[1]
    if (destination !== undefined && destination !== '') links.push(destination)
  }
  return links
}

function isUrl(link: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(link) || link.startsWith('//')
}

/**
 * Resolve one link to a project-relative file, or the reason it is excluded.
 * `baseDir` is the folder the link is relative to (the document's folder for
 * document links, the project root for GoldfishContext entries).
 */
async function resolveLink(
  projectRoot: string,
  baseDir: string,
  link: string,
): Promise<{ file: string } | { excluded: ExcludedLink['reason'] }> {
  if (link.startsWith('#')) return { excluded: 'anchor-only' }
  const withoutFragment = link.split('#')[0] ?? ''
  if (withoutFragment === '') return { excluded: 'anchor-only' }
  if (isUrl(withoutFragment)) return { excluded: 'url' }
  const absolute = resolve(baseDir, decodeURIComponent(withoutFragment))
  if (!isInside(projectRoot, absolute)) return { excluded: 'outside-project' }
  try {
    const real = await realpath(absolute)
    const realRoot = await realpath(projectRoot)
    if (!isInside(realRoot, real)) return { excluded: 'outside-project' }
  } catch {
    return { excluded: 'missing' }
  }
  return { file: toPosix(relative(projectRoot, absolute)) }
}

/**
 * Build the Goldfish context for a review: the target document plus every
 * file it links to that stays inside the project. Nothing else — in
 * particular, no chat history. A missing target or a target outside the
 * project is an error, not an empty context: a review of nothing is not a
 * review.
 */
export async function buildGoldfishContext(
  options: BuildGoldfishContextOptions,
): Promise<BuildGoldfishContextResult> {
  const projectRoot = resolve(options.projectRoot)
  const read = options.read ?? defaultRead
  const targetAbsolute = resolve(projectRoot, options.targetFile)
  if (!isInside(projectRoot, targetAbsolute)) {
    return { ok: false, error: `target ${options.targetFile} is outside the project` }
  }
  let targetContent: string
  try {
    targetContent = await read(targetAbsolute)
  } catch {
    return { ok: false, error: `cannot read target ${options.targetFile}` }
  }
  const targetPath = toPosix(relative(projectRoot, targetAbsolute))
  const targetDir = dirname(targetAbsolute)

  const seen = new Set<string>([targetPath])
  const files: GoldfishFile[] = []
  const excluded: ExcludedLink[] = []

  const addFile = async (path: string): Promise<void> => {
    if (seen.has(path)) return
    seen.add(path)
    try {
      const content = await read(resolve(projectRoot, path))
      files.push({ path, content })
    } catch {
      excluded.push({ link: path, reason: 'missing' })
    }
  }

  for (const link of extractMarkdownLinks(targetContent)) {
    const resolved = await resolveLink(projectRoot, targetDir, link)
    if ('excluded' in resolved) {
      excluded.push({ link, reason: resolved.excluded })
    } else {
      await addFile(resolved.file)
    }
  }
  for (const entry of options.extraContext ?? []) {
    const resolved = await resolveLink(projectRoot, projectRoot, entry)
    if ('excluded' in resolved) {
      excluded.push({ link: entry, reason: resolved.excluded })
    } else {
      await addFile(resolved.file)
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return {
    ok: true,
    context: {
      target: { path: targetPath, content: targetContent },
      files,
      excluded,
      priorChatTurns: 0,
      note:
        'Goldfish context: the target document and its linked files only. ' +
        'No prior chat history — a reviewer in this session cannot know why a decision was made, only what the document says.',
    },
  }
}
