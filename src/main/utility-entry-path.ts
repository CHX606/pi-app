import { basename, dirname, join } from 'node:path'

let appPathOf: () => string = () => process.cwd()

/**
 * Where the app lives (desktop: Electron's `app.getAppPath()`, installed by
 * `worker-launcher-electron.ts`; headless host: its bundle directory). Defaults to the cwd, which is
 * the repo root in tests and dev scripts.
 */
export function setUtilityAppPath(resolve: () => string): void {
  appPathOf = resolve
}

export function resolveUtilityEntry(
  entryName: 'worker.mjs' | 'preview.mjs' | 'preview-wsl.mjs',
  appPath = appPathOf(),
): string {
  const mainDir = basename(appPath) === 'main' && basename(dirname(appPath)) === 'out'
    ? appPath
    : join(appPath, 'out', 'main')
  return join(mainDir, entryName)
}
