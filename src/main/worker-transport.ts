/**
 * Transport abstraction over a worker process. Three implementations:
 *  - `utilityProcess` (desktop host mode): Electron utilityProcess + message port,
 *    see `worker-launcher-electron.ts`
 *  - `wsl` (WSL mode): `wsl.exe -d <distro> --cd ... -- node worker.mjs` with
 *    prefixed JSONL framing over stdout / stdin
 *  - `node` (headless host): `node worker.mjs` as a plain child process, same framing as WSL
 */

import { spawn, type ChildProcess } from 'child_process'
import { StringDecoder } from 'node:string_decoder'
import { decodeWorkerFrameLine, WORKER_STDIO_ENV } from '@shared/worker-frame'
import type { WorkerResponsePayload } from '@shared/worker-rpc-types'
import { spawnWorkerInWsl } from './wsl/worker-host'

export interface WorkerTransport {
  readonly kind: 'utilityProcess' | 'wsl' | 'node'
  readonly pid?: number
  postMessage(message: Record<string, unknown>): void
  onMessage(callback: (message: WorkerResponsePayload) => void): void
  onExit(callback: (code: number) => void): void
  onStdout(callback: (chunk: string) => void): void
  onStderr(callback: (chunk: string) => void): void
  kill(): void
}

/** A worker child speaking prefixed JSONL frames on stdout and plain JSONL on stdin. */
function createStdioChildTransport(child: ChildProcess, kind: 'wsl' | 'node'): WorkerTransport {
  let messageCb: ((message: WorkerResponsePayload) => void) | null = null
  let exitCb: ((code: number) => void) | null = null
  let stdoutCb: ((chunk: string) => void) | null = null
  let stderrCb: ((chunk: string) => void) | null = null
  let frameBuffer = ''
  const stdoutDecoder = new StringDecoder('utf8')

  child.stdout?.on('data', (chunk: Buffer) => {
    frameBuffer += stdoutDecoder.write(chunk)
    let idx = frameBuffer.indexOf('\n')
    while (idx >= 0) {
      const line = frameBuffer.slice(0, idx)
      frameBuffer = frameBuffer.slice(idx + 1)
      const msg = decodeWorkerFrameLine(line)
      if (msg) {
        messageCb?.(msg as WorkerResponsePayload)
      } else if (line.trim()) {
        stderrCb?.(`[${kind}-stdout] ${line}\n`)
      }
      idx = frameBuffer.indexOf('\n')
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrCb?.(chunk.toString())
  })
  child.on('error', (err) => {
    stderrCb?.(`[${kind}] ${String(err?.message ?? err)}\n`)
    exitCb?.(-1)
  })
  child.on('exit', (code) => {
    exitCb?.(code ?? -1)
  })

  return {
    kind,
    get pid() {
      return child.pid
    },
    postMessage: (message) => {
      if (child.stdin?.writable) {
        child.stdin.write(JSON.stringify(message) + '\n')
      }
    },
    onMessage: (cb) => {
      messageCb = cb
    },
    onExit: (cb) => {
      exitCb = cb
    },
    onStdout: (cb) => {
      stdoutCb = cb
    },
    onStderr: (cb) => {
      stderrCb = cb
    },
    kill: () => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    },
  }
}

export function createWslWorkerTransport(opts: {
  distro: string
  wslCwd: string
  workerWslPath: string
}): WorkerTransport {
  return createStdioChildTransport(spawnWorkerInWsl(opts), 'wsl')
}

/** `node <entry>` in `cwd` with stdio framing (no Electron): the headless host's workers. */
export function createNodeWorkerTransport(opts: {
  entry: string
  cwd: string
  /** Node binary; defaults to the one running this process. */
  node?: string
  env?: NodeJS.ProcessEnv
}): WorkerTransport {
  const child = spawn(opts.node ?? process.execPath, [opts.entry], {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...opts.env, [WORKER_STDIO_ENV]: '1' },
  })
  return createStdioChildTransport(child, 'node')
}
