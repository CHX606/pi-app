import { beforeEach, describe, expect, it } from 'vitest'
import { clearSessionShellForTests } from '@renderer/lib/session-shell'
import { sessionStateForTest } from '@renderer/test/session-state-helpers'
import { useUIStore } from '../ui-store'

const sessionFile = '/workspace/session.jsonl'

describe('visible run terminal retires the session turn markers', () => {
  beforeEach(() => {
    clearSessionShellForTests()
    useUIStore.setState({
      currentWorkspace: '/workspace',
      currentSessionId: 'session-1',
      historySessionFile: sessionFile,
      timelineItems: [
        { id: 'u1', type: 'user-message', text: 'question', timestamp: 1 },
        { id: 'a1', type: 'assistant-message', text: 'partial answer done', thinkingText: '', timestamp: 2 },
      ],
      streamingAssistantId: 'a1',
      optimisticPendingUserText: null,
      agentTurnBootstrapping: false,
      pendingSteering: [],
      pendingFollowUp: [],
      sessionRuntimeRunning: { [sessionFile]: true },
      workerLiveSnapshot: { sessionId: 'session-1', sessionFile, status: 'running' },
      runState: { status: 'running', activeRunId: 'run-1', toolCount: 0, errorCount: 0 },
    })
  })

  it('should_clear_streaming_markers_when_visible_run_goes_idle', () => {
    useUIStore.getState().processEvent({
      type: 'run', phase: 'idle', runId: 'run-1', seq: 10, workspaceId: '/workspace', sessionFile, timestamp: 5,
    })

    const own = sessionStateForTest(sessionFile)
    expect(own?.runState.status).toBe('idle')
    expect(own?.streamingAssistantId).toBeNull()
    expect(own?.optimisticPendingUserText).toBeNull()
    expect(own?.agentTurnBootstrapping).toBe(false)
    expect(Object.values(useUIStore.getState().sessionRuntimeRunning).some((v) => v === true)).toBe(false)
  })

  it('should_clear_streaming_markers_when_visible_run_fails', () => {
    useUIStore.getState().processEvent({
      type: 'run', phase: 'failed', runId: 'run-1', seq: 10, workspaceId: '/workspace', sessionFile, timestamp: 5,
    })

    const own = sessionStateForTest(sessionFile)
    expect(own?.runState.status).toBe('failed')
    expect(own?.streamingAssistantId).toBeNull()
  })

  it('should_clear_streaming_markers_on_visible_agent_abort', () => {
    useUIStore.getState().processEvent({
      type: 'agent_error', text: 'aborted', kind: 'aborted', runId: 'run-1', seq: 10,
      workspaceId: '/workspace', sessionFile, timestamp: 5,
    })

    const own = sessionStateForTest(sessionFile)
    expect(own?.runState.status).toBe('idle')
    expect(own?.streamingAssistantId).toBeNull()
  })
})
