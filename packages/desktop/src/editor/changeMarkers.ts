// The editor's change markers need one thing from git: the open file as it is in HEAD.
//
// It is fetched when a file is shown and fetched again whenever it may have changed —
// a commit, a branch switch or a pull (each changes the git status), a terminal
// command, or the window coming back to the front. Responses that arrive after the
// user moved to another file are dropped. No client, no git, a file outside the
// project or a file git does not have: all mean "no markers", never an error.

import { useEffect, useRef, useState } from 'react'

import { useOptionalSketchClient } from '../lib/ClientProvider'
import { useOptionalGit } from '../git/GitProvider'
import { useAppState } from '../state/AppState'
import { useDiskChangeSignal } from './diskSync'
import { isWithinRoot } from './paths'

/**
 * The committed text of `path`: a string, null when HEAD has nothing to compare with,
 * or undefined while it is not known (not fetched yet, or no git in this window).
 */
export function useHeadBaseline(path: string | null): string | null | undefined {
  const client = useOptionalSketchClient()
  const git = useOptionalGit()
  const projectRoot = useAppState().projectRoot
  const [held, setHeld] = useState<{ path: string; content: string | null } | null>(null)
  const [epoch, setEpoch] = useState(0)
  const generation = useRef(0)

  // A terminal command or another program may have committed or switched branches. A
  // watcher report of ordinary file edits does not change what HEAD holds; only one
  // that touched git's own state (or could not say what changed) does.
  useDiskChangeSignal((change) => {
    if (change.git || change.paths === null) setEpoch((n) => n + 1)
  })

  const status = git?.status ?? null
  const gitShow = client?.gitShow
  useEffect(() => {
    if (path === null || projectRoot === null || gitShow === undefined) return
    if (!isWithinRoot(projectRoot, path)) return
    const mine = ++generation.current
    gitShow
      .call(client, { root: projectRoot, path })
      .then(
        (result) => {
          if (generation.current === mine) setHeld({ path, content: result.content })
        },
        () => {
          if (generation.current === mine) setHeld({ path, content: null })
        },
      )
    // `status` is in the list on purpose: a commit, a switch or a pull changes it, and
    // each may change what HEAD holds for this file.
  }, [client, gitShow, path, projectRoot, status, epoch])

  return held !== null && held.path === path ? held.content : undefined
}
