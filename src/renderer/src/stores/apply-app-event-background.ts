import type { AppEvent } from '@shared/app-events'
import { applyBackgroundAppEventToLiveTimeline } from '@renderer/lib/live-session-timeline-cache'
import { markSessionDiskAuthoritative } from '@renderer/lib/session-disk-authority'

/** Session key for runtime map / background cache — event.sessionFile only. */
export function eventSessionFile(event: AppEvent): string | null {
  if ('sessionFile' in event && typeof (event as { sessionFile?: string }).sessionFile === 'string') {
    return (event as { sessionFile?: string }).sessionFile || null
  }
  return null
}

/**
 * Background (non-visible) session bookkeeping that is not part of its keyed state: the live
 * timeline cache that switch-back merges with disk, and disk authority once a turn settles.
 * The session's own state is reduced by the shared handlers (see `applyAppEvent`).
 */
export function applyBackgroundAppEvent(event: AppEvent): void {
  const cacheFile = eventSessionFile(event)
  if (!cacheFile) return
  if (event.type === 'completion' || event.type === 'extension_widget') return

  // Stream text deltas are rAF-batched in the live cache.
  applyBackgroundAppEventToLiveTimeline(cacheFile, event)

  if (event.type !== 'run') return
  // The turn is persisted now; switch-back must re-read disk instead of trusting the live cache.
  if (event.phase === 'idle' || event.phase === 'failed' || event.phase === 'cancelled') {
    markSessionDiskAuthoritative(cacheFile)
  }
}
