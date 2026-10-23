import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcClient } from '@renderer/lib/ipc-client'
import { useUIStore } from '@renderer/stores/ui-store'
import { commitSessionDisplayMeta, applyComposerDisplayMeta } from '@renderer/lib/session-display-meta'
import { applyThinkingLevel, nextThinkingLevel } from './thinking-level-actions'

vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke: vi.fn() } }))
vi.mock('@renderer/lib/session-display-meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/session-display-meta')>()
  return { ...actual, commitSessionDisplayMeta: vi.fn(actual.commitSessionDisplayMeta) }
})
vi.mock('@renderer/lib/model-thinking-bindings', () => ({
  boundThinkingLevelFor: vi.fn(),
  setModelThinkingBinding: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const invoke = vi.mocked(ipcClient.invoke)

beforeEach(() => {
  vi.clearAllMocks()
  invoke.mockReset()
  useUIStore.setState({
    historySessionFile: '/sessions/a.jsonl',
    runState: { status: 'running', model: 'openai/model', thinkingLevel: 'xhigh', toolCount: 0, errorCount: 0 },
    workerLiveSnapshot: { sessionId: 'a', sessionFile: '/sessions/a.jsonl', status: 'running' },
  })
})

describe('applyThinkingLevel session isolation', () => {
  it('keeps a draft selection local while another session is running', async () => {
    useUIStore.setState({ historySessionFile: null })

    await applyThinkingLevel('medium')

    expect(useUIStore.getState().runState.thinkingLevel).toBe('medium')
    // The running session keeps its own level and worker binding.
    const a = useUIStore.getState().sessionStates['/sessions/a.jsonl']
    expect(a.runState.thinkingLevel).toBe('xhigh')
    expect(a.workerLiveSnapshot).toEqual({ sessionId: 'a', sessionFile: '/sessions/a.jsonl', status: 'running' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('should_keep_draft_selection_when_pending_defaults_resolve', async () => {
    useUIStore.setState({ historySessionFile: null })
    let resolve!: (value: unknown) => void
    invoke.mockReturnValue(new Promise((done) => { resolve = done }))
    const refresh = applyComposerDisplayMeta()

    await applyThinkingLevel('medium')
    resolve({ settings: { defaultProvider: 'openai', defaultModel: 'model', defaultThinkingLevel: 'low' } })
    await refresh

    expect(useUIStore.getState().runState.thinkingLevel).toBe('medium')
  })

  it('targets the viewed session even when another session owns the foreground worker', async () => {
    useUIStore.setState({ historySessionFile: '/sessions/b.jsonl' })
    invoke.mockResolvedValue({ level: 'medium' })

    await applyThinkingLevel('medium')

    expect(invoke).toHaveBeenCalledExactlyOnceWith('thinkingLevel.set', {
      sessionId: '', sessionFile: '/sessions/b.jsonl', level: 'medium',
    })
    expect(commitSessionDisplayMeta).toHaveBeenCalledWith('/sessions/b.jsonl', { thinkingLevel: 'medium' })
  })

  it('does not roll back another session when a switch fails after navigation', async () => {
    let reject!: (error: Error) => void
    invoke.mockReturnValue(new Promise((_, fail) => { reject = fail }))
    const change = applyThinkingLevel('medium')
    useUIStore.setState({
      historySessionFile: '/sessions/b.jsonl',
      runState: { ...useUIStore.getState().runState, thinkingLevel: 'high' },
    })

    reject(new Error('switch failed'))
    await change

    expect(useUIStore.getState().runState.thinkingLevel).toBe('high')
  })

  it('keeps a newer selection when an earlier switch fails', async () => {
    let reject!: (error: Error) => void
    invoke.mockReturnValueOnce(new Promise((_, fail) => { reject = fail }))
    invoke.mockResolvedValueOnce({ level: 'high' })
    const earlier = applyThinkingLevel('medium')
    await applyThinkingLevel('high')

    reject(new Error('earlier switch failed'))
    await earlier

    expect(useUIStore.getState().runState.thinkingLevel).toBe('high')
  })

  it('rolls back a failed switch in the same session', async () => {
    invoke.mockRejectedValue(new Error('switch failed'))

    await applyThinkingLevel('medium')

    expect(useUIStore.getState().runState.thinkingLevel).toBe('xhigh')
    expect(commitSessionDisplayMeta).not.toHaveBeenCalled()
  })
})

describe('nextThinkingLevel', () => {
  it('steps through supported levels and wraps', () => {
    const available = ['off', 'low', 'medium', 'high']
    expect(nextThinkingLevel('low', available)).toBe('medium')
    expect(nextThinkingLevel('high', available)).toBe('off')
  })

  it('treats an empty list as every level supported', () => {
    expect(nextThinkingLevel('xhigh', [])).toBe('max')
    expect(nextThinkingLevel(undefined, undefined)).toBe('minimal')
  })
})
