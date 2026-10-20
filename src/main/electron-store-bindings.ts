import { BrowserWindow, safeStorage } from 'electron'
import Store from 'electron-store'
import { CONFIG_DEFAULTS, installConfigBacking, type StoreSchema } from './config-store'
import { installSecretCipher } from './secret-store'

/**
 * Desktop backings for the config store and secret store. `index.ts` imports this module before
 * anything that reads settings; the headless host (`src/host`) installs its own instead.
 */

const store = new Store<StoreSchema>({ name: 'pi-desktop', defaults: CONFIG_DEFAULTS })

installConfigBacking({
  get: (key) => store.get(key as keyof StoreSchema),
  set: (key, value) => store.set(key as keyof StoreSchema, value as StoreSchema[keyof StoreSchema]),
  delete: (key) => store.delete(key as keyof StoreSchema),
  get store() {
    return store.store as unknown as Record<string, unknown>
  },
})

installSecretCipher({
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (sealed) => safeStorage.decryptString(sealed),
  warnUnavailable(message) {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) win.webContents.send('ipc:events', { type: 'warning', message })
  },
})
