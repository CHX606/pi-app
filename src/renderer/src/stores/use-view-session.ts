import { useUIStore } from '@renderer/stores/ui-store'
import {
  selectSessionState,
  selectViewSession,
  sessionKeyOf,
  type SessionState,
} from '@renderer/stores/session-state'

/** Subscribe to a slice of the visible session's state. Keep selectors returning stable values. */
export function useViewSession<T>(selector: (session: SessionState) => T): T {
  return useUIStore((s) => selector(selectViewSession(s)))
}

/** Current state of the visible session (empty state when nothing is viewed). */
export function getViewSession(): SessionState {
  return selectViewSession(useUIStore.getState())
}

/** Current state of one session by file or key, or null when it has none yet. */
export function getSessionState(sessionFileOrKey: string | null | undefined): SessionState | null {
  return selectSessionState(useUIStore.getState(), sessionFileOrKey)
}

export { sessionKeyOf }
