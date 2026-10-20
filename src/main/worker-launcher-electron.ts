import { app, utilityProcess, type UtilityProcess } from 'electron'
import type { WorkerResponsePayload } from '@shared/worker-rpc-types'
import { resolveActiveSdk } from './sdk-loader'
import { resolveUtilityEntry, setUtilityAppPath } from './utility-entry-path'
import { installBrowserToolBridge, installHostWorkerLauncher } from './worker-manager-pool'
import type { WorkerTransport } from './worker-transport'

/**
 * Desktop wiring of the worker pool: host-mode workers are Electron utility processes running the
 * SDK the user selected, and browser tools are served by the built-in browser. `index.ts` installs
 * this before any worker starts; the headless host installs node children and no browser instead.
 */

export function createUtilityProcessTransport(proc: UtilityProcess): WorkerTransport {
  return {
    kind: 'utilityProcess',
    get pid() {
      return proc.pid
    },
    postMessage: (message) => proc.postMessage(message),
    onMessage: (cb) => {
      proc.on('message', (event: { data?: WorkerResponsePayload } | WorkerResponsePayload) => {
        const data =
          typeof event === 'object' && event !== null && 'data' in event
            ? (event as { data?: WorkerResponsePayload }).data
            : (event as WorkerResponsePayload)
        if (data) cb(data)
      })
    },
    onExit: (cb) => {
      proc.on('exit', (code) => cb(code))
    },
    onStdout: (cb) => {
      const s = proc.stdout
      if (s) {
        s.on('error', () => {})
        s.on('data', (chunk: Buffer) => cb(chunk.toString()))
      }
    },
    onStderr: (cb) => {
      const s = proc.stderr
      if (s) {
        s.on('error', () => {})
        s.on('data', (chunk: Buffer) => cb(chunk.toString()))
      }
    },
    kill: () => {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
    },
  }
}

setUtilityAppPath(() => app.getAppPath())

installHostWorkerLauncher(() => {
  const forked = utilityProcess.fork(resolveUtilityEntry('worker.mjs'), [], { stdio: 'pipe' })
  const activeSdk = resolveActiveSdk(app.getPath('userData'))
  return {
    transport: createUtilityProcessTransport(forked),
    sdkPath: activeSdk.kind === 'builtin' ? null : activeSdk.entryPath,
  }
})

installBrowserToolBridge(() => import('./browser/browser-tool-bridge'))
