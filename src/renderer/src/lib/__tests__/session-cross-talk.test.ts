/**
 * Cross-talk regressions for multi-session runtime: session A's events must never change
 * what the renderer shows for session B. See doc/dev/per-session-state-design.md.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipcMock = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue({}) }))

vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke: ipcMock.invoke } }))
vi.mock('@renderer/lib/session-display-meta', () => ({
  applyComposerDisplayMeta: vi.fn().mockResolvedValue(undefined),
  commitSessionDisplayMeta: vi.fn(),
  notifyModelFallback: vi.fn(),
}))
vi.mock('@renderer/lib/extension-ui-tool-sync', () => ({ reconcileAllStaleInteractiveToolRows: vi.fn() }))
vi.mock('@renderer/features/timeline/timeline-bottom-anchor', () => ({ requestTimelineBottomAnchor: vi.fn() }))

import type { AppEvent } from '@shared/app-events'
import { clearLiveSessionTimeline } from '@renderer/lib/live-session-timeline-cache'
import { clearSessionHistoryCache } from '@renderer/lib/session-history'
import { clearSessionShellForTests, focusSessionSync } from '@renderer/lib/session-shell'
import { clearStreamPending } from '@renderer/stores/ui-store-stream'
import { useUIStore } from '@renderer/stores/ui-store'

const WS = 'C:/w'
const A = 'C:/w/sessions/a.jsonl'
const B = 'C:/w/sessions/b.jsonl'

let seq = 0
function ev<T extends Record<string, unknown>>(body: T, sessionFile?: string): AppEvent {
  return {
    seq: ++seq,
    workspaceId: WS,
    timestamp: Date.now(),
    ...(sessionFile ? { sessionFile } : {}),
    ...body,
  } as unknown as AppEvent
}

function viewB(): void {
  focusSessionSync('sid-b', B)
}

describe('session cross-talk', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    clearStreamPending()
    clearLiveSessionTimeline()
    clearSessionShellForTests()
    clearSessionHistoryCache()
    useUIStore.setState({
      currentWorkspace: WS,
      currentSessionId: null,
      historySessionFile: null,
      timelineItems: [],
      streamingAssistantId: null,
      optimisticPendingUserText: null,
      agentTurnBootstrapping: false,
      pendingSteering: [],
      pendingFollowUp: [],
      sessionRuntimeRunning: {},
      sessionAttention: {},
      workerLiveSnapshot: { sessionId: null, sessionFile: null, status: 'idle' },
      runState: { status: 'idle', toolCount: 0, errorCount: 0 },
    })
  })

  describe('step 1 — events route only by sessionFile', () => {
    it('drops an unscoped run event instead of lighting the visible session (0.7.6 wrong run state)', () => {
      viewB()
      useUIStore.getState().processEvent(ev({ type: 'run', phase: 'running', runId: 'r-a' }))
      const s = useUIStore.getState()
      expect(s.runState.status).toBe('idle')
      expect(s.runState.activeRunId).toBeUndefined()
      expect(s.sessionRuntimeRunning).toEqual({})
    })

    it('drops an unscoped queue event instead of showing it in the visible session', () => {
      viewB()
      useUIStore.getState().processEvent(ev({ type: 'queue', steering: ['from A'], followUp: [] }))
      expect(useUIStore.getState().pendingSteering).toEqual([])
    })

    it('drops unscoped assistant text instead of appending it to the visible timeline', () => {
      viewB()
      useUIStore.getState().processEvent(ev({ type: 'message', role: 'assistant', phase: 'start' }))
      useUIStore.getState().processEvent(ev({ type: 'message', role: 'assistant', phase: 'delta', text: 'A says' }))
      expect(useUIStore.getState().timelineItems).toEqual([])
    })

    it("keeps A's scoped run in A while B is visible", () => {
      viewB()
      useUIStore.getState().processEvent(ev({ type: 'run', phase: 'running', runId: 'r-a' }, A))
      const s = useUIStore.getState()
      expect(s.runState.status).toBe('idle')
      expect(s.sessionRuntimeRunning[A]).toBe(true)
      expect(s.sessionRuntimeRunning[B]).toBeUndefined()
    })

    it("still applies B's own scoped run to the visible session", () => {
      viewB()
      useUIStore.getState().processEvent(ev({ type: 'run', phase: 'running', runId: 'r-b' }, B))
      const s = useUIStore.getState()
      expect(s.runState.status).toBe('running')
      expect(s.sessionRuntimeRunning[B]).toBe(true)
    })
  })
})
