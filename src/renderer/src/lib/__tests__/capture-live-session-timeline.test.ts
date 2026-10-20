import { beforeEach, describe, expect, it, vi } from 'vitest'

const workerFile = '/tmp/worker.jsonl'
const previewFile = '/tmp/preview.jsonl'

vi.mock('@renderer/lib/session-shell', () => ({ captureFocusFromUiStore: vi.fn() }))

let mockState: Record<string, unknown> = {}

vi.mock('@renderer/stores/ui-store', () => ({
  useUIStore: {
    getState: () => mockState,
    setState: vi.fn(),
  },
}))

describe('captureVisibleLiveSessionTimeline', () => {
  beforeEach(() => {
    mockState = {
      historySessionFile: previewFile,
      workerLiveSnapshot: { sessionId: 'w1', sessionFile: workerFile, status: 'running' },
      setSessionRuntimeRunning: vi.fn(),
    }
  })

  it('keeps the worker session marked running when leaving a preview of another session', async () => {
    const { captureVisibleLiveSessionTimeline } = await import('../capture-live-session-timeline')
    captureVisibleLiveSessionTimeline()
    expect(mockState.setSessionRuntimeRunning).toHaveBeenCalledWith(workerFile, true)
  })

  it('leaves the runtime map alone when the worker runs the visible session', async () => {
    mockState.historySessionFile = workerFile
    const { captureVisibleLiveSessionTimeline } = await import('../capture-live-session-timeline')
    captureVisibleLiveSessionTimeline()
    expect(mockState.setSessionRuntimeRunning).not.toHaveBeenCalled()
  })
})
