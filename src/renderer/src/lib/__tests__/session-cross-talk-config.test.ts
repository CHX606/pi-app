/**
 * Model / thinking cross-talk: a session's model and thinking level are its own, and async
 * confirmations land on the session they were started for (0.7.6 thinking-level fixes).
 * See doc/dev/per-session-state-design.md, step 4.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipcMock = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke: ipcMock.invoke } }))
vi.mock('@renderer/lib/model-thinking-bindings', () => ({
  boundThinkingLevelFor: vi.fn(),
  setModelThinkingBinding: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() } }))
vi.mock('@renderer/lib/extension-ui-tool-sync', () => ({ reconcileAllStaleInteractiveToolRows: vi.fn() }))
vi.mock('@renderer/features/timeline/timeline-bottom-anchor', () => ({ requestTimelineBottomAnchor: vi.fn() }))

import type { AppEvent } from '@shared/app-events'
import { applyThinkingLevel } from '@renderer/features/composer/thinking-level-actions'
import { applyComposerDisplayMeta, forgetSessionDisplayMeta } from '@renderer/lib/session-display-meta'
import { clearSessionHistoryCache } from '@renderer/lib/session-history'
import { clearSessionShellForTests, focusSessionSync } from '@renderer/lib/session-shell'
import { useUIStore } from '@renderer/stores/ui-store'

const WS = 'C:/w'
const A = 'C:/w/sessions/a.jsonl'
const B = 'C:/w/sessions/b.jsonl'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

function view(file: string, thinkingLevel: string, model: string): void {
  focusSessionSync(file === A ? 'sid-a' : 'sid-b', file)
  useUIStore.getState().setSessionRunState(file, { thinkingLevel, model })
}

describe('session model / thinking cross-talk', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    ipcMock.invoke.mockReset()
    ipcMock.invoke.mockResolvedValue({})
    clearSessionShellForTests()
    clearSessionHistoryCache()
    forgetSessionDisplayMeta()
    useUIStore.setState({
      currentWorkspace: WS,
      currentSessionId: null,
      historySessionFile: null,
      sessionStates: {},
      sessionRuntimeRunning: {},
      lastModel: null,
      lastThinking: null,
    })
  })

  it("rolls a failed thinking change back on its own session, not the one switched to", async () => {
    view(B, 'low', 'm/b')
    view(A, 'high', 'm/a')
    const pending = deferred<unknown>()
    ipcMock.invoke.mockImplementation((method: string) =>
      method === 'thinkingLevel.set' ? pending.promise : Promise.resolve({}),
    )

    const applying = applyThinkingLevel('max')
    expect(useUIStore.getState().runState.thinkingLevel).toBe('max')
    view(B, 'low', 'm/b')
    pending.reject(new Error('nope'))
    await applying

    expect(useUIStore.getState().runState.thinkingLevel).toBe('low')
    expect(useUIStore.getState().sessionStates[A].runState.thinkingLevel).toBe('high')
  })

  it('applies a late display-meta refresh to the session it was started for', async () => {
    view(A, 'high', 'm/a')
    view(B, 'low', 'm/b')
    focusSessionSync('sid-a', A)
    const runtime = deferred<unknown>()
    ipcMock.invoke.mockImplementation((method: string) => {
      if (method === 'ipc:runtime.getState') return runtime.promise
      return Promise.resolve({})
    })

    const refreshing = applyComposerDisplayMeta()
    focusSessionSync('sid-b', B)
    runtime.resolve({ state: { sessionFile: A, model: 'm/a-live', thinkingLevel: 'xhigh' } })
    await refreshing

    expect(useUIStore.getState().runState).toMatchObject({ model: 'm/b', thinkingLevel: 'low' })
    expect(useUIStore.getState().sessionStates[A].runState).toMatchObject({ model: 'm/a-live', thinkingLevel: 'xhigh' })
  })

  it("keeps a background session's reported thinking level out of the visible one (0.7.6)", () => {
    view(A, 'high', 'm/a')
    view(B, 'low', 'm/b')
    useUIStore.getState().processEvent({
      type: 'run',
      phase: 'state',
      seq: 1,
      workspaceId: WS,
      sessionFile: A,
      timestamp: 1,
      model: 'm/a2',
      thinkingLevel: 'minimal',
    } as AppEvent)

    expect(useUIStore.getState().runState).toMatchObject({ model: 'm/b', thinkingLevel: 'low' })
    expect(useUIStore.getState().sessionStates[A].runState).toMatchObject({ model: 'm/a2', thinkingLevel: 'minimal' })
  })

  it("changes a new chat's thinking level without touching the running session (0.7.6)", async () => {
    view(A, 'high', 'm/a')
    useUIStore.getState().setSessionRuntimeRunning(A, true)
    const { enterBlankSession } = await import('@renderer/lib/blank-session-transition')
    enterBlankSession('pending-project')

    await applyThinkingLevel('minimal')

    expect(useUIStore.getState().runState.thinkingLevel).toBe('minimal')
    expect(useUIStore.getState().sessionStates[A].runState.thinkingLevel).toBe('high')
    expect(ipcMock.invoke).not.toHaveBeenCalledWith('thinkingLevel.set', expect.anything())
  })

  it("carries the draft's model and thinking into the session it becomes", async () => {
    view(A, 'high', 'm/a')
    const { enterBlankSession } = await import('@renderer/lib/blank-session-transition')
    enterBlankSession('pending-project')
    await applyThinkingLevel('minimal')

    useUIStore.getState().promoteViewSession({ sessionId: 'sid-new', sessionFile: 'C:/w/sessions/new.jsonl' })

    expect(useUIStore.getState().historySessionFile).toBe('C:/w/sessions/new.jsonl')
    expect(useUIStore.getState().runState).toMatchObject({ model: 'm/a', thinkingLevel: 'minimal' })
    expect(useUIStore.getState().sessionStates[A].runState.thinkingLevel).toBe('high')
  })
})
