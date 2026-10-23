import type { AppEvent } from '@shared/app-events'
import { markSessionDiskAuthoritative } from '@renderer/lib/session-disk-authority'

/** Session key for runtime map — event.sessionFile only. */
export function eventSessionFile(event: AppEvent): string | null {
  if ('sessionFile' in event && typeof (event as { sessionFile?: string }).sessionFile === 'string') {
    return (event as { sessionFile?: string }).sessionFile || null
  }
  return null
}

/**
 * Background (non-visible) session bookkeeping that is not part of its keyed state: disk authority
 * once a turn settles. The session's own state is reduced by the shared handlers (see `applyAppEvent`).
 */
export function applyBackgroundAppEvent(event: AppEvent): void {
  if (event.type !== 'run') return
  const sessionFile = eventSessionFile(event)
  if (!sessionFile) return
  // The turn is persisted now; switch-back must re-read the disk tail.
  if (event.phase === 'idle' || event.phase === 'failed' || event.phase === 'cancelled') {
    markSessionDiskAuthoritative(sessionFile)
  }
}
