import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcClient } from '@renderer/lib/ipc-client'
import { useUIStore } from '@renderer/stores/ui-store'
import { useComposerMetrics } from './use-composer-metrics'
import { clearAvailableModelsCacheForTests } from '@renderer/lib/available-models-cache'
import { clearContextPreviewCacheForTests } from '@renderer/features/context/use-session-context-preview'

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: vi.fn(() => Promise.resolve({})) },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('useComposerMetrics context isolation', () => {
  beforeEach(() => {
    vi.mocked(ipcClient.invoke).mockReset()
    clearAvailableModelsCacheForTests()
    clearContextPreviewCacheForTests()
    useUIStore.setState({
      currentWorkspace: '/workspace',
      currentSessionId: 'session-a',
      historySessionFile: '/sessions/a.jsonl',
      historyLoading: false,
      runState: {
        status: 'idle',
        model: undefined,
        usage: undefined,
        toolCount: 0,
        errorCount: 0,
      },
      streamingAssistantId: null,
      timelineItems: [],
    })
  })

  it('requests context for the visible session file', async () => {
    vi.mocked(ipcClient.invoke).mockResolvedValue({
      preview: {
        sessionFile: '/sessions/a.jsonl',
        messageCount: 1,
        estimatedChars: 10,
      },
    })

    renderHook(() => useComposerMetrics())

    await waitFor(() => {
      expect(ipcClient.invoke).toHaveBeenCalledWith('context.preview', {
        sessionFile: '/sessions/a.jsonl',
        workspaceId: '/workspace',
      })
    })
  })

  it('should_refresh_sdk_usage_when_the_visible_model_changes', async () => {
    let contextWindow = 100_000
    useUIStore.setState({ runState: { ...useUIStore.getState().runState, model: 'custom/old' } })
    vi.mocked(ipcClient.invoke).mockImplementation(async (channel) => {
      if (channel === 'context.preview') return {
        preview: {
          sessionFile: '/sessions/a.jsonl', messageCount: 1, estimatedChars: 400,
          contextUsage: { tokens: 1000, contextWindow, percent: 1000 / contextWindow * 100 },
        },
      }
      return { models: ['old', 'new'].map((id) => ({
        id, provider: 'custom', name: id, contextWindow: id === 'old' ? 100_000 : 200_000,
      })) }
    })
    const { result } = renderHook(() => useComposerMetrics())
    await waitFor(() => expect(result.current.contextWindow).toBe(100_000))

    contextWindow = 200_000
    act(() => useUIStore.setState({ runState: { ...useUIStore.getState().runState, model: 'custom/new' } }))

    await waitFor(() => expect(result.current.contextWindow).toBe(200_000))
    expect(result.current.ctxPct).toBe(0.5)
  })

  it('ignores a late response from the previous session', async () => {
    const first = deferred<{
      preview: { sessionFile: string; messageCount: number; estimatedChars: number }
    }>()
    vi.mocked(ipcClient.invoke).mockImplementation((channel, request) => {
      if (channel !== 'context.preview') return Promise.resolve({})
      const sessionFile = (request as { sessionFile?: string } | undefined)?.sessionFile
      if (sessionFile === '/sessions/a.jsonl') return first.promise
      return Promise.resolve({
        preview: {
          sessionFile: '/sessions/b.jsonl',
          messageCount: 2,
          estimatedChars: 20,
        },
      })
    })
    const { result } = renderHook(() => useComposerMetrics())

    act(() => {
      useUIStore.setState({
        currentSessionId: 'session-b',
        historySessionFile: '/sessions/b.jsonl',
      })
    })
    await waitFor(() => expect(result.current.contextPreview?.estimatedChars).toBe(20))

    await act(async () => {
      first.resolve({
        preview: {
          sessionFile: '/sessions/a.jsonl',
          messageCount: 1,
          estimatedChars: 10,
        },
      })
      await first.promise
    })

    expect(result.current.contextPreview?.estimatedChars).toBe(20)
  })
})
