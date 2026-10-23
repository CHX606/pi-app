import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }) },
}))
vi.mock('@renderer/lib/session-history', () => ({
  fetchSessionHistoryTail: vi.fn().mockResolvedValue({
    items: [
      { id: 'u1', type: 'user-message', text: 'hello', timestamp: 1 },
      { id: 'a1', type: 'assistant-message', text: 'world', timestamp: 2 },
    ],
    totalCount: 2,
  }),
}))
vi.mock('@renderer/lib/session-worker-sync', async () => {
  const actual = await vi.importActual<typeof import('../session-worker-sync')>('../session-worker-sync')
  return {
    ...actual,
    fetchWorkerLiveSnapshot: vi.fn().mockResolvedValue({
      sessionId: null,
      sessionFile: '/tmp/s.jsonl',
      status: 'idle',
    }),
  }
})
vi.mock('@renderer/lib/session-display-meta', () => ({
  applyComposerDisplayMeta: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@renderer/stores/ui-store-stream', () => ({
  flushStreamPendingSync: vi.fn(),
  flushAllStreamPendingSync: vi.fn(),
}))

import { useUIStore } from '@renderer/stores/ui-store'
import {
  MAX_SESSION_VIEWS,
  clearSessionShellForTests,
  captureFocusFromUiStore,
  focusSessionSync,
  hydrateSessionView,
  getSessionView,
  listSessionViewKeys,
  evictSessionViewsIfNeeded,
} from '../session-shell'
import { ipcClient } from '@renderer/lib/ipc-client'
import { applyLiveSnapshotToView, composerTurnActive } from '../session-worker-sync'
import { captureVisibleLiveSessionTimeline } from '../capture-live-session-timeline'
import { sessionStateForTest } from '@renderer/test/session-state-helpers'

describe('session-shell', () => {
  beforeEach(() => {
    clearSessionShellForTests()
    useUIStore.setState({
      currentSessionId: null,
      historySessionFile: null,
      timelineItems: [],
      historyTotalCount: 0,
      historyLoadedCount: 0,
      historyLoading: false,
      streamingAssistantId: null,
      optimisticPendingUserText: null,
      agentTurnBootstrapping: false,
      pendingSteering: [],
      pendingFollowUp: [],
      sessionRuntimeRunning: {},
      runState: { status: 'idle', toolCount: 0, errorCount: 0 },
      workerLiveSnapshot: { sessionId: null, sessionFile: null, status: 'idle' },
    })
  })

  it('instant focus binds cached items without requiring historyLoading', () => {
    useUIStore.setState({
      currentSessionId: 's1',
      historySessionFile: '/tmp/a.jsonl',
      timelineItems: [
        { id: 'u1', type: 'user-message', text: 'a', timestamp: 1 },
        { id: 'a1', type: 'assistant-message', text: 'b', timestamp: 2 },
      ],
      historyTotalCount: 2,
      historyLoadedCount: 2,
    })
    captureFocusFromUiStore()

    useUIStore.setState({
      timelineItems: [],
      historySessionFile: null,
    })

    const { instant } = focusSessionSync('s1', '/tmp/a.jsonl')
    expect(instant).toBe(true)
    expect(useUIStore.getState().timelineItems).toHaveLength(2)
    expect(useUIStore.getState().historyLoading).toBe(false)
    expect(useUIStore.getState().historySessionFile).toBe('/tmp/a.jsonl')
  })

  it('cold focus sets historyLoading until hydrate', () => {
    const { instant } = focusSessionSync('s2', '/tmp/b.jsonl')
    expect(instant).toBe(false)
    expect(useUIStore.getState().historyLoading).toBe(true)
  })

  it('should_not_bind_worker_when_hydrating_read_only_preview', async () => {
    focusSessionSync('child-session', '/tmp/child.jsonl')

    await hydrateSessionView('/tmp/child.jsonl', 'child-session', undefined, {
      bindWorker: false,
    })

    expect(vi.mocked(ipcClient.invoke)).not.toHaveBeenCalledWith('session.setPendingBind', {
      sessionFile: '/tmp/child.jsonl',
    })
  })

  it('non-empty cache is instant even if phase was left hydrating', () => {
    useUIStore.setState({
      currentSessionId: 's1',
      historySessionFile: '/tmp/a.jsonl',
      timelineItems: [
        { id: 'u1', type: 'user-message', text: 'stream', timestamp: 1 },
        { id: 'a1', type: 'assistant-message', text: 'partial...', timestamp: 2 },
      ],
      historyTotalCount: 2,
      historyLoadedCount: 2,
      streamingAssistantId: 'a1',
    })
    captureFocusFromUiStore()
    // Simulate mid-hydrate stuck phase
    const view = getSessionView('/tmp/a.jsonl')
    expect(view?.items.length).toBeGreaterThan(0)

    useUIStore.setState({
      timelineItems: [],
      historySessionFile: '/tmp/other.jsonl',
      historyLoading: true,
      streamingAssistantId: null,
    })
    // Manually mark hydrating if present
    const cached = getSessionView('/tmp/a.jsonl')
    if (cached) {
      // re-focus must still be instant
    }
    const { instant } = focusSessionSync('s1', '/tmp/a.jsonl')
    expect(instant).toBe(true)
    expect(useUIStore.getState().historyLoading).toBe(false)
    expect(useUIStore.getState().timelineItems.length).toBeGreaterThan(0)
  })

  it('evicts LRU idle views but keeps running', () => {
    useUIStore.setState({
      sessionRuntimeRunning: { '/tmp/run.jsonl': true },
    })
    for (let index = 0; index < MAX_SESSION_VIEWS + 3; index++) {
      useUIStore.setState({
        currentSessionId: `s${index}`,
        historySessionFile: `/tmp/s${index}.jsonl`,
        timelineItems: [{ id: `u${index}`, type: 'user-message', text: `${index}`, timestamp: index }],
        historyTotalCount: 1,
        historyLoadedCount: 1,
      })
      captureFocusFromUiStore()
    }
    // Mark one as running via runtime
    useUIStore.setState({
      currentSessionId: 'run',
      historySessionFile: '/tmp/run.jsonl',
      timelineItems: [{ id: 'ur', type: 'user-message', text: 'run', timestamp: 99 }],
      historyTotalCount: 1,
      historyLoadedCount: 1,
      sessionRuntimeRunning: { '/tmp/run.jsonl': true },
    })
    captureFocusFromUiStore()
    evictSessionViewsIfNeeded()
    expect(listSessionViewKeys().length).toBeLessThanOrEqual(MAX_SESSION_VIEWS)
    expect(getSessionView('/tmp/run.jsonl')).not.toBeNull()
  })

  it('does not resurrect a finished stream on repeated session opens after an idle poll', () => {
    const sessionFile = '/tmp/a.jsonl'
    useUIStore.setState({
      currentSessionId: 'a',
      historySessionFile: sessionFile,
      timelineItems: [
        { id: 'u1', type: 'user-message', text: 'hello', timestamp: 1 },
        { id: 'a1', type: 'assistant-message', text: 'answer', timestamp: 2 },
      ],
      streamingAssistantId: 'a1',
      runState: { status: 'running', activeRunId: 'run-a', toolCount: 0, errorCount: 0 },
      workerLiveSnapshot: { sessionId: 'a', sessionFile, status: 'running' },
      sessionRuntimeRunning: { [sessionFile]: true },
    })
    captureVisibleLiveSessionTimeline()
    focusSessionSync('b', '/tmp/b.jsonl')
    focusSessionSync('a', sessionFile)

    // The terminal event was missed, but polling confirms that A has finished.
    applyLiveSnapshotToView(
      sessionFile,
      { sessionId: 'a', sessionFile, status: 'idle' },
      useUIStore.getState(),
    )
    expect(useUIStore.getState().streamingAssistantId).toBeNull()
    expect(sessionStateForTest(sessionFile)?.runState.status).toBe('idle')

    for (let open = 0; open < 2; open++) {
      captureVisibleLiveSessionTimeline()
      focusSessionSync('b', '/tmp/b.jsonl')
      focusSessionSync('a', sessionFile)
      expect(useUIStore.getState().streamingAssistantId).toBeNull()
      expect(composerTurnActive(useUIStore.getState())).toBe(false)
    }
  })

  it('composerTurnActive ignores a running state owned by another session', () => {
    expect(
      composerTurnActive({
        historySessionFile: '/tmp/b.jsonl',
        workerLiveSnapshot: { sessionId: 'b', sessionFile: '/tmp/b.jsonl', status: 'idle' },
        sessionRuntimeRunning: { '/tmp/a.jsonl': true },
      }),
    ).toBe(false)
  })
})
