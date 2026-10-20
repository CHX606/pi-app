import { patchSessionState } from '@renderer/stores/session-scope'
import { sessionKeyOf, type SessionState } from '@renderer/stores/session-state'
import { useUIStore } from '@renderer/stores/ui-store'
import type { RunState, TimelineItem } from '@renderer/stores/ui-store-types'

/** What a background session holds in memory: its rows, run state and turn markers. */
export type SessionSnapshotForTest = {
  sessionFile: string
  sessionId?: string | null
  timelineItems: TimelineItem[]
  streamingAssistantId: string | null
  runState: RunState
  pendingSteering?: string[]
  pendingFollowUp?: string[]
  optimisticPendingUserText?: string | null
  agentTurnBootstrapping?: boolean
}

/** Seed a session's own state as if its events had already arrived (e.g. a background turn). */
export function seedSessionForTest(snapshot: SessionSnapshotForTest): void {
  const key = sessionKeyOf(snapshot.sessionFile)
  patchSessionState(key, {
    timelineItems: snapshot.timelineItems.map((item) => ({ ...item })),
    streamingAssistantId: snapshot.streamingAssistantId,
    runState: snapshot.runState,
    pendingSteering: snapshot.pendingSteering ?? [],
    pendingFollowUp: snapshot.pendingFollowUp ?? [],
    optimisticPendingUserText: snapshot.optimisticPendingUserText ?? null,
    agentTurnBootstrapping: snapshot.agentTurnBootstrapping ?? false,
    ...(snapshot.sessionId !== undefined
      ? { workerLiveSnapshot: { sessionId: snapshot.sessionId, sessionFile: key, status: snapshot.runState.status } }
      : {}),
  })
}

/** A session's own state, or null if the renderer holds nothing for it. */
export function sessionStateForTest(sessionFile: string): SessionState | null {
  return useUIStore.getState().sessionStates[sessionKeyOf(sessionFile)] ?? null
}
