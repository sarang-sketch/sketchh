// React access to the scoped-command seam, in the same shape as `FileIoProvider`.
//
// Production renders no provider and gets `bridgeCommandIo`. A test wraps the tree
// in `<CommandIoProvider io={...}>` and drives the real panels against a process
// double. Panels take the interface from context and never import the bridge.

import { createContext, useContext, type ReactNode } from 'react'
import { bridgeCommandIo, type CommandIo } from './commandIo'

const CommandIoContext = createContext<CommandIo>(bridgeCommandIo)

export function CommandIoProvider({ io, children }: { io: CommandIo; children: ReactNode }) {
  return <CommandIoContext.Provider value={io}>{children}</CommandIoContext.Provider>
}

export function useCommandIo(): CommandIo {
  return useContext(CommandIoContext)
}
