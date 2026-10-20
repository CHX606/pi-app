import { captureFocusFromUiStore } from '@renderer/lib/session-shell'
import { sessionFilesEqual } from '@renderer/lib/session-file-key'
import { useUIStore } from '@renderer/stores/ui-store'

/**
 * Before the view leaves a session: land its batched stream text and keep the runtime map honest
 * for turns still in flight. Each session's rows already live in its own `sessionStates` entry
 * (background events keep it current), so nothing is copied.
 */
export function captureVisibleLiveSessionTimeline(): void {
  captureFocusFromUiStore()

  // Leaving a preview while a *different* worker session is still running: keep it marked running.
  const state = useUIStore.getState()
  const workerFile = state.workerLiveSnapshot.sessionFile
  if (!workerFile || state.workerLiveSnapshot.status !== 'running') return
  if (sessionFilesEqual(workerFile, state.historySessionFile)) return
  state.setSessionRuntimeRunning(workerFile, true)
}
