import type { AppEvent } from '@shared/app-events'
import { isSessionScopedAppEvent, type SessionScopedAppEvent } from '@shared/app-event-session'
import { resolveAppEventRoute } from '@renderer/stores/apply-app-event-route'
import { useUIStore } from '@renderer/stores/ui-store'
import {
  handleAgentError,
  handleCompaction,
  handleMessage,
  handleRun,
  handleSlash,
  handleTool,
} from '@renderer/stores/apply-app-event-handlers'
import { applyBackgroundAppEvent } from '@renderer/stores/apply-app-event-background'
import { sessionStoreApi } from '@renderer/stores/session-scope'
import { sessionKeyOf } from '@renderer/stores/session-state'
import { applyExtensionWidgetEvent, getSessionComposerWidget } from '@renderer/lib/extension-widget-cache'
import { markLiveSessionTurnEnded } from '@renderer/lib/live-session-timeline-cache'
import { isAbortQueueIgnoreActive, shouldIgnoreAppEventAfterAbort } from '@renderer/lib/abort-ui-hold'
import { reduceSubagentSessionGroupToolEvent } from '@renderer/lib/subagent-session-activity'
import type { StoreApi } from '@renderer/stores/apply-app-event-types'

export type { StoreApi } from '@renderer/stores/apply-app-event-types'

export function applyAppEvent(event: AppEvent, api: StoreApi): void {
  if (!isSessionScopedAppEvent(event)) return
  if (shouldIgnoreAppEventAfterAbort(event)) return
  const state = api.get()
  if (event.type === 'tool' && state.subagentSessionGroup) {
    const nextGroup = reduceSubagentSessionGroupToolEvent(state.subagentSessionGroup, event)
    if (nextGroup !== state.subagentSessionGroup) {
      state.setSubagentSessionGroup(nextGroup)
    }
  }
  const route = resolveAppEventRoute(state, event)
  if (route === 'drop') return
  // The route guarantees a session file; it is the only session identity an event has.
  const sessionFile = event.sessionFile as string
  if (route === 'background') {
    applyBackgroundAppEvent(event)
    applySessionEvent(event, sessionStoreApi(sessionKeyOf(sessionFile), api.nextItemId), sessionFile, false)
    return
  }
  applySessionEvent(event, api, sessionFile, true)
}

/**
 * Reduce one session's event into that session's state. `api` is the view store for the visible
 * session or the session's own scope for a background one — the handlers are the same.
 */
function applySessionEvent(
  event: SessionScopedAppEvent,
  api: StoreApi,
  sessionFile: string,
  visible: boolean,
): void {
  const state = api.get()
  switch (event.type) {
    case 'message':
      handleMessage(event, api)
      break
    case 'tool':
      handleTool(event, api)
      break
    case 'file':
      state.addFileChange({
        path: event.path,
        source: event.source,
        changeType: event.changeType,
        turnId: event.turnId,
        runId: event.runId,
      })
      break
    case 'run': {
      const accepted = handleRun(event, api)
      if (accepted && (event.phase === 'running' || event.phase === 'started')) {
        useUIStore.getState().setSessionRuntimeRunning(sessionFile, true)
      } else if (event.phase === 'idle') {
        if (api.get().runState.status === 'idle') {
          useUIStore.getState().setSessionRuntimeRunning(sessionFile, false)
          markLiveSessionTurnEnded(sessionFile, 'idle')
        }
      } else if (event.phase === 'failed' || event.phase === 'cancelled') {
        useUIStore.getState().setSessionRuntimeRunning(sessionFile, false)
        markLiveSessionTurnEnded(sessionFile, event.phase === 'failed' ? 'failed' : 'idle')
      }
      break
    }
    case 'compaction':
      handleCompaction(event, api, { clearDialogs: visible })
      break
    case 'slash':
      handleSlash(event, api)
      break
    case 'queue':
      if (isAbortQueueIgnoreActive(sessionFile)) {
        const hasQueued = (event.steering?.length ?? 0) > 0 || (event.followUp?.length ?? 0) > 0
        if (hasQueued) break
      }
      state.setPendingQueue(event.steering, event.followUp)
      break
    case 'agent_error': {
      handleAgentError(event, api)
      markLiveSessionTurnEnded(sessionFile, event.kind === 'aborted' ? 'idle' : 'failed')
      break
    }
    case 'completion': {
      if (event.settled === true) useUIStore.getState().markSessionSettled(sessionFile)
      break
    }
    case 'extension_widget': {
      applyExtensionWidgetEvent(event)
      api.get().setComposerWidget(getSessionComposerWidget(sessionFile))
      break
    }
  }
}
