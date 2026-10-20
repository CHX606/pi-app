import type { AppEvent } from '@shared/app-events'
import type { WorkerResponsePayload } from '@shared/worker-rpc-types'
import type { WorkerTransport } from './worker-transport'

export type WorkerInitResult = {
  sessionId: string
  model?: string
  thinkingLevel?: string
}

export type WorkerSlot = {
  /** Pool map key: sessionFile abs path or `ws:${cwd}` */
  poolKey: string
  cwd: string
  /** Runtime identity captured when this worker was created. */
  runtime: { mode: 'host' | 'wsl'; distro: string | null }
  /** Bound session file when known; null for workspace-only slots */
  sessionFile: string | null
  worker: WorkerTransport
  pendingRequests: Map<
    string,
    { resolve: (v: WorkerResponsePayload) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >
  requestCounter: number
  initResolver: ((r: WorkerInitResult) => void) | null
  initRejecter: ((e: Error) => void) | null
  initPromise: Promise<WorkerInitResult> | null
  agentTurnActive: boolean
  /** Last time turn became idle (ms); used for idle TTL eviction */
  lastIdleAt: number
  /** Last time this slot was foreground (ms) */
  lastForegroundAt: number
  sdkFallback: boolean
  autoRestartEnabled: boolean
  stopping: boolean
  /** Fork/clone RPCs awaiting a session switch; such slots are not reused for other sessions. */
  identityOpsInFlight?: number
}

/**
 * The part of a BrowserWindow the worker pool talks to. Structural so the pool never imports
 * Electron; the headless host simply has no window (null).
 */
export type RendererWindow = {
  isDestroyed(): boolean
  webContents: { send(channel: string, ...args: unknown[]): void }
}

/** Starts a worker for host-mode runtimes (desktop: utilityProcess; headless: node child). */
export type HostWorkerLauncher = (cwd: string) => { transport: WorkerTransport; sdkPath: string | null }

/** Serves `browser-tool-*` requests from workers (desktop only: needs Electron views). */
export type BrowserToolBridge = {
  handleBrowserToolRequest(
    data: Record<string, unknown>,
    slot: { cwd: string; sessionFile?: string | null; poolKey: string },
    post: (message: Record<string, unknown>) => void,
  ): Promise<void>
  cancelBrowserToolRequest(callId: string): void
}

export type WorkerAppEventForward = {
  event: AppEvent
  fromCwd: string
  fromPoolKey: string
  sessionFile: string | null
  agentTurnActive: boolean
}
