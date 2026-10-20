import type { SessionScopedAppEvent } from '@shared/app-event-session'
import { workspacePathsEqual } from '@shared/workspace-path'
import { sessionFilesEqual } from '@renderer/lib/session-file-key'
import { isPlaceholderSessionId } from '@renderer/lib/session-ids'
import { alertTrace } from '@renderer/lib/alert-trace'

export type AppEventRoute = 'visible' | 'background' | 'drop'

type RouteState = {
  currentWorkspace: string | null
  currentSessionId: string | null
  historySessionFile: string | null
  workerLiveSnapshot: { sessionId: string | null; sessionFile: string | null }
}

/**
 * Decide where a session event goes, by its `sessionFile` only.
 *
 * Worker events always carry the session file (worker `baseEvent()`, filled in by main from the
 * worker slot). An event without one cannot be attributed to a session, so it is dropped — never
 * applied to whatever session happens to be visible (that re-lit B with A's run after a switch).
 */
export function resolveAppEventRoute(state: RouteState, event: SessionScopedAppEvent): AppEventRoute {
  const evFile = event.sessionFile
  if (!evFile) {
    alertTrace('app event without sessionFile dropped', {
      type: event.type,
      phase: (event as { phase?: string }).phase,
    })
    return 'drop'
  }

  const evWs = event.workspaceId
  const viewWs = state.currentWorkspace
  if (evWs && viewWs && !workspacePathsEqual(evWs, viewWs)) return 'background'

  const viewFile = state.historySessionFile
  if (viewFile) return sessionFilesEqual(evFile, viewFile) ? 'visible' : 'background'

  const viewSid = state.currentSessionId
  if (!viewSid || isPlaceholderSessionId(viewSid)) return 'background'

  // A real session whose file is not known yet (first send): only its bound worker is visible.
  const workerFile = state.workerLiveSnapshot.sessionFile
  if (workerFile && sessionFilesEqual(evFile, workerFile)) return 'visible'
  return 'background'
}
