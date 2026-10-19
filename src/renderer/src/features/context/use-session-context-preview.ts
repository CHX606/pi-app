import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { SessionContextPreview } from '@shared/session-context-preview'
import { ipcClient } from '@renderer/lib/ipc-client'
import { normalizeSessionFileKey, sessionFilesEqual } from '@renderer/lib/session-file-key'
import { useUIStore } from '@renderer/stores/ui-store'

const RUNNING_CONTEXT_REFRESH_MS = 8000
/** A preview this young is reused on mount / focus instead of refetched. */
const FRESH_CONTEXT_MS = 2000

/**
 * One shared context preview per session. Composer metrics, the Run panel and the Context panel
 * render the same data; `context.preview` walks every session message (Worker) or parses the whole
 * JSONL (disk), so each consumer fetching on its own tripled that work on every switch and tick.
 */
type Entry = {
  preview: SessionContextPreview | null
  loading: boolean
  fetchedAt: number
}

const EMPTY: Entry = { preview: null, loading: false, fetchedAt: 0 }
const entries = new Map<string, Entry>()
const inFlight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

function entryKey(workspace: string, sessionFile: string, model: string | undefined): string {
  return `${workspace}|${normalizeSessionFileKey(sessionFile) || sessionFile}|${model ?? ''}`
}

const MAX_CACHED_PREVIEWS = 16

function setEntry(key: string, entry: Entry): void {
  // Re-insert to keep Map order = recency, then drop the least recently updated sessions.
  entries.delete(key)
  entries.set(key, entry)
  for (const oldest of entries.keys()) {
    if (entries.size <= MAX_CACHED_PREVIEWS) break
    if (!inFlight.has(oldest)) entries.delete(oldest)
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function ensureContextPreview(
  workspace: string,
  sessionFile: string,
  model: string | undefined,
  opts: { force?: boolean; maxAgeMs?: number } = {},
): Promise<void> {
  const key = entryKey(workspace, sessionFile, model)
  const pending = inFlight.get(key)
  if (pending) return pending
  const current = entries.get(key)
  if (!opts.force && current && Date.now() - current.fetchedAt < (opts.maxAgeMs ?? FRESH_CONTEXT_MS)) {
    return Promise.resolve()
  }
  if (typeof document !== 'undefined' && document.hidden) return Promise.resolve()

  setEntry(key, { ...(current ?? EMPTY), loading: true })
  const request = (async () => {
    let preview: SessionContextPreview | null = null
    try {
      const response = await ipcClient.invoke('context.preview', { sessionFile, workspaceId: workspace })
      const next = (response?.preview || null) as SessionContextPreview | null
      preview = next && sessionFilesEqual(next.sessionFile, sessionFile) ? next : null
    } catch {
      preview = null
    }
    setEntry(key, { preview, loading: false, fetchedAt: Date.now() })
  })().finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, request)
  return request
}

export function useSessionContextPreview(options?: { enabled?: boolean }) {
  const enabled = options?.enabled !== false
  const workspace = useUIStore((state) => state.currentWorkspace)
  const sessionFile = useUIStore((state) => state.historySessionFile)
  const historyLoading = useUIStore((state) => state.historyLoading)
  const isRunning = useUIStore((state) => state.runState.status === 'running')
  const model = useUIStore((state) => state.runState.model)
  const active = enabled && !!workspace && !!sessionFile && !historyLoading
  const key = active ? entryKey(workspace!, sessionFile!, model) : null

  const entry = useSyncExternalStore(
    subscribe,
    () => (key ? (entries.get(key) ?? EMPTY) : EMPTY),
    () => EMPTY,
  )

  const refresh = useCallback(async (): Promise<void> => {
    if (!active) return
    await ensureContextPreview(workspace!, sessionFile!, model, { force: true })
  }, [active, workspace, sessionFile, model])

  // Mount / session or model switch: reuse a fresh shared preview, else fetch once for all consumers.
  useEffect(() => {
    if (!active) return
    void ensureContextPreview(workspace!, sessionFile!, model)
  }, [active, workspace, sessionFile, model])

  // Turn boundary changes the context; concurrent consumers coalesce on the in-flight request.
  const lastRunning = useRef(isRunning)
  useEffect(() => {
    if (lastRunning.current === isRunning) return
    lastRunning.current = isRunning
    if (active) void ensureContextPreview(workspace!, sessionFile!, model, { force: true })
  }, [active, workspace, sessionFile, model, isRunning])

  useEffect(() => {
    if (!active) return
    const intervalId = isRunning
      ? window.setInterval(
          () =>
            void ensureContextPreview(workspace!, sessionFile!, model, {
              maxAgeMs: RUNNING_CONTEXT_REFRESH_MS - 500,
            }),
          RUNNING_CONTEXT_REFRESH_MS,
        )
      : null
    const onVisibility = () => {
      if (!document.hidden) void ensureContextPreview(workspace!, sessionFile!, model)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (intervalId != null) window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active, workspace, sessionFile, model, isRunning])

  return { preview: active ? entry.preview : null, loading: active && entry.loading, refresh }
}

export function clearContextPreviewCacheForTests(): void {
  entries.clear()
  inFlight.clear()
}
