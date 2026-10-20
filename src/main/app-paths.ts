/**
 * Per-install data directory without importing Electron. The desktop installs Electron's
 * `app.getPath('userData')` (electron-store-bindings.ts); the headless host installs its home dir.
 */

let userData: (() => string) | null = null

export function setUserDataDir(resolve: () => string): void {
  userData = resolve
}

export function userDataDir(): string {
  if (!userData) throw new Error('userData directory used before it was installed')
  return userData()
}
