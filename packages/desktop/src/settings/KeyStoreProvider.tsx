// React access to credential storage, in the same shape as the file and client seams.
//
// Production renders no provider and gets `bridgeKeyStore` (the Rust commands). A test
// wraps the tree in `<KeyStoreProvider store={...}>` and drives the real panel against
// a double. Components take the interface from context and never import the bridge, so
// there is one path to the OS credential store and it is replaceable in a test.

import { createContext, useContext, type ReactNode } from 'react'
import { bridgeKeyStore, type KeyStore } from './keyStore'

const KeyStoreContext = createContext<KeyStore>(bridgeKeyStore)

export function KeyStoreProvider({ store, children }: { store: KeyStore; children: ReactNode }) {
  return <KeyStoreContext.Provider value={store}>{children}</KeyStoreContext.Provider>
}

export function useKeyStore(): KeyStore {
  return useContext(KeyStoreContext)
}
