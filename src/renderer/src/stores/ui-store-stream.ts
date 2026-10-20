import type { TimelineItem } from '@renderer/stores/ui-store-types'

export { mergeStreamChunk } from '@shared/stream-merge'

type StreamFlushKind = 'text' | 'thinking'

type StreamStore = {
  streamingAssistantId: string | null
  timelineItems: TimelineItem[]
}

type StreamScope = {
  get: () => StreamStore
  set: (fn: (s: StreamStore) => Partial<StreamStore> | StreamStore) => void
}

/**
 * Token deltas are batched per streaming row and flushed once a frame. Each row remembers the
 * store scope (the view store or one background session) it streams into, so sessions streaming
 * at the same time never flush into each other. A scope is identified by its `get` function.
 */
const streamPending = new Map<string, { text: string; thinking: string; scope: StreamScope }>()

let streamFlushScheduled = false
let streamFlushFrame: number | null = null
let streamFlushTimer: ReturnType<typeof setTimeout> | null = null

function cancelStreamFlush(): void {
  if (streamFlushFrame != null) cancelAnimationFrame(streamFlushFrame)
  if (streamFlushTimer != null) clearTimeout(streamFlushTimer)
  streamFlushFrame = null
  streamFlushTimer = null
  streamFlushScheduled = false
}

function flushScope(scope: StreamScope): void {
  const sid = scope.get().streamingAssistantId
  if (!sid) {
    for (const [id, row] of streamPending) {
      if (row.scope.get === scope.get) streamPending.delete(id)
    }
    return
  }
  const pending = streamPending.get(sid)
  if (!pending || pending.scope.get !== scope.get || (!pending.text && !pending.thinking)) return
  const textDelta = pending.text
  const thinkDelta = pending.thinking
  streamPending.delete(sid)
  scope.set((s) => {
    if (s.streamingAssistantId !== sid) return s
    const index = s.timelineItems.findIndex((row) => row.id === sid)
    if (index < 0) return s
    const current = s.timelineItems[index]
    let nextText = current.text || ''
    let nextThinking = current.thinkingText || ''
    let changed = false
    if (textDelta) {
      nextText += textDelta
      changed = true
    }
    if (thinkDelta) {
      nextThinking += thinkDelta
      changed = true
    }
    if (!changed) return s
    // Copy once and patch the streaming row — avoid dual full-array maps per flush.
    const items = s.timelineItems.slice()
    items[index] = { ...current, text: nextText, thinkingText: nextThinking }
    return { timelineItems: items }
  })
}

function flushAllScopes(): void {
  cancelStreamFlush()
  const scopes = new Map<StreamScope['get'], StreamScope>()
  for (const row of streamPending.values()) scopes.set(row.scope.get, row.scope)
  for (const scope of scopes.values()) flushScope(scope)
}

function scheduleStreamFlush(): void {
  if (streamFlushScheduled) return
  streamFlushScheduled = true
  // Hidden or occluded windows can suspend animation frames while IPC keeps arriving.
  streamFlushTimer = setTimeout(flushAllScopes, 100)
  streamFlushFrame = requestAnimationFrame(flushAllScopes)
}

/** Flush the batched deltas of one store scope now (before reading or replacing its timeline). */
export function flushStreamPendingSync<S extends StreamStore>(
  get: () => S,
  set: (fn: (s: S) => Partial<S> | S) => void,
): void {
  flushScope({ get, set } as unknown as StreamScope)
  if (streamPending.size === 0) cancelStreamFlush()
}

export function queueStreamDelta<S extends StreamStore>(
  get: () => S,
  set: (fn: (s: S) => Partial<S> | S) => void,
  kind: StreamFlushKind,
  delta: string,
): void {
  const sid = get().streamingAssistantId
  if (!sid || !delta) return
  let row = streamPending.get(sid)
  if (!row || row.scope.get !== get) {
    row = { text: '', thinking: '', scope: { get, set } as unknown as StreamScope }
    streamPending.set(sid, row)
  }
  if (kind === 'text') row.text += delta
  else row.thinking += delta
  scheduleStreamFlush()
}

/** Drop the batched deltas of one store scope only (other sessions keep streaming). */
export function clearStreamPendingFor(get: () => unknown): void {
  for (const [id, row] of streamPending) {
    if (row.scope.get === get) streamPending.delete(id)
  }
  if (streamPending.size === 0) cancelStreamFlush()
}

export function clearStreamPending(): void {
  streamPending.clear()
  cancelStreamFlush()
}

export function deleteStreamPendingForId(id: string): void {
  streamPending.delete(id)
}
