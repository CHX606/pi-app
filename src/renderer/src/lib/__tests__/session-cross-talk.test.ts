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

  describe('step 3 — run state per session', () => {
    function viewA(): void {
      focusSessionSync('sid-a', A)
    }
    function startTurn(file: string, runId: string): void {
      useUIStore.getState().processEvent(ev({ type: 'run', phase: 'started', runId }, file))
      useUIStore.getState().processEvent(ev({ type: 'run', phase: 'running', runId }, file))
    }

    it('shows the target session idle after switching away from a running one (0.7.6)', () => {
      viewA()
      startTurn(A, 'r-a')
      viewB()
      const s = useUIStore.getState()
      expect(s.runState.status).toBe('idle')
      expect(s.runState.activeRunId).toBeUndefined()
      expect(s.workerLiveSnapshot.sessionFile).toBe(B)
      expect(s.workerLiveSnapshot.status).toBe('idle')
    })

    it('keeps the running session running with its run id across a switch and back (0.5.7 stop button)', () => {
      viewA()
      startTurn(A, 'r-a')
      viewB()
      viewA()
      const s = useUIStore.getState()
      expect(s.runState.status).toBe('running')
      expect(s.runState.activeRunId).toBe('r-a')
    })

    it('reduces a background tool into its own session only', () => {
      viewA()
      startTurn(A, 'r-a')
      viewB()
      useUIStore.getState().processEvent(
        ev({ type: 'tool', phase: 'start', toolName: 'bash', toolCallId: 't1', runId: 'r-a', input: {} }, A),
      )
      expect(useUIStore.getState().runState.activeTool).toBeUndefined()
      expect(useUIStore.getState().sessionStates[A].runState.activeTool).toBe('bash')
    })

    it('settles a session that finished in the background (no stale running on switch-back)', () => {
      viewA()
      startTurn(A, 'r-a')
      viewB()
      useUIStore.getState().processEvent(ev({ type: 'run', phase: 'idle', runId: 'r-a' }, A))
      expect(useUIStore.getState().sessionStates[A].runState.status).toBe('idle')
      viewA()
      expect(useUIStore.getState().runState.status).toBe('idle')
      expect(useUIStore.getState().runState.activeRunId).toBeUndefined()
    })

    it("does not carry the leaving session's local turn markers into the target (0.5.1)", () => {
      viewA()
      useUIStore.setState({ optimisticPendingUserText: 'hello A', agentTurnBootstrapping: true })
      useUIStore.getState().setSessionRuntimeRunning(A, true)
      viewB()
      expect(useUIStore.getState().optimisticPendingUserText).toBeNull()
      expect(useUIStore.getState().agentTurnBootstrapping).toBe(false)
      viewA()
      expect(useUIStore.getState().optimisticPendingUserText).toBe('hello A')
    })

    it('keeps background run state when the view switches to a session never opened before', () => {
      viewA()
      startTurn(A, 'r-a')
      focusSessionSync('sid-c', 'C:/w/sessions/c.jsonl')
      expect(useUIStore.getState().runState.status).toBe('idle')
      expect(useUIStore.getState().sessionStates[A].runState.status).toBe('running')
    })

    it("does not show the previous session's usage in a new chat", async () => {
      viewA()
      useUIStore.getState().setRunState({ usage: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0, cost: 1 } })
      const { enterBlankSession } = await import('@renderer/lib/blank-session-transition')
      enterBlankSession('pending-project')
      expect(useUIStore.getState().runState.usage).toBeUndefined()
      expect(useUIStore.getState().sessionStates[A].runState.usage?.input).toBe(9)
    })
  })

  describe('step 5 — queue, file changes and composer inputs per session', () => {
    it("shows a background session's queue only in that session", () => {
      viewB()
      useUIStore.getState().processEvent(ev({ type: 'queue', steering: ['steer A'], followUp: ['later A'] }, A))
      expect(useUIStore.getState().pendingSteering).toEqual([])
      expect(useUIStore.getState().pendingFollowUp).toEqual([])
      focusSessionSync('sid-a', A)
      expect(useUIStore.getState().pendingSteering).toEqual(['steer A'])
      expect(useUIStore.getState().pendingFollowUp).toEqual(['later A'])
    })

    it("keeps the visible queue when switching away and back, without leaking it", () => {
      focusSessionSync('sid-a', A)
      useUIStore.getState().processEvent(ev({ type: 'queue', steering: ['steer A'], followUp: [] }, A))
      viewB()
      expect(useUIStore.getState().pendingSteering).toEqual([])
      focusSessionSync('sid-a', A)
      expect(useUIStore.getState().pendingSteering).toEqual(['steer A'])
    })

    it('records file changes in the session that made them', () => {
      viewB()
      useUIStore.getState().processEvent(
        ev({ type: 'file', path: 'src/a.ts', source: 'tool', changeType: 'modify', runId: 'r-a' }, A),
      )
      expect(useUIStore.getState().fileChanges).toEqual([])
      focusSessionSync('sid-a', A)
      expect(useUIStore.getState().fileChanges.map((f) => f.path)).toEqual(['src/a.ts'])
      viewB()
      focusSessionSync('sid-a', A)
      expect(useUIStore.getState().fileChanges.map((f) => f.path)).toEqual(['src/a.ts'])
    })

    it('keeps composer text pushed into one session out of the session switched to', () => {
      focusSessionSync('sid-a', A)
      useUIStore.getState().setComposerPrefill('forked prompt for A')
      viewB()
      expect(useUIStore.getState().composerPrefill).toBeNull()
      focusSessionSync('sid-a', A)
      expect(useUIStore.getState().composerPrefill).toBe('forked prompt for A')
    })

    it("does not project a background session's extension widget onto the visible composer", () => {
      viewB()
      useUIStore.getState().processEvent(
        ev(
          {
            type: 'extension_widget',
            phase: 'set',
            widgetKey: 'goal',
            adapterId: 'goal',
            protocol: 'tasks',
            state: { title: 'A goal' },
          },
          A,
        ),
      )
      expect(useUIStore.getState().composerWidget).toBeNull()
      expect(useUIStore.getState().sessionStates[A].composerWidget).toEqual({ title: 'A goal' })
    })
  })
})
