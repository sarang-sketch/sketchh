// React access to the file layer, in the same shape as the client seam.
//
// Production renders no provider at all and gets `bridgeFileIo`. A test wraps the
// tree in `<FileIoProvider io={...}>` and drives real reducer transitions against a
// fake disk. Components take the interface from context and never import the bridge.

import { createContext, useContext, type ReactNode } from 'react'
import { bridgeFileIo, type FileIo } from './fileIo'

const FileIoContext = createContext<FileIo>(bridgeFileIo)

export function FileIoProvider({ io, children }: { io: FileIo; children: ReactNode }) {
  return <FileIoContext.Provider value={io}>{children}</FileIoContext.Provider>
}

export function useFileIo(): FileIo {
  return useContext(FileIoContext)
}
