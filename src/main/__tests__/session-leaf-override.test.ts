import { beforeEach, describe, expect, it } from 'vitest'
import type { AppEvent } from '@shared/app-events'
import {
  applySessionEventToSessionLeafOverride,
  clearSessionLeafOverride,
  getSessionLeafOverride,
  setSessionLeafOverride,
} from '../session-leaf-override'

describe('session leaf override lifecycle', () => {
  beforeEach(() => {
    clearSessionLeafOverride()
  })

  it('should_clear_rewind_override_after_matching_session_settles', () => {
    const sessionFile = '/workspace/session-a.jsonl'
    setSessionLeafOverride(sessionFile, 'rewound-leaf')

    applySessionEventToSessionLeafOverride({
      type: 'run',
      phase: 'idle',
      settled: true,
      sessionFile,
      seq: 1,
      workspaceId: '/workspace',
      timestamp: 1,
    } as AppEvent)

    expect(getSessionLeafOverride(sessionFile)).toBeUndefined()
  })

  it('clears the old rewind once the new user message is persisted', () => {
    const sessionFile = '/workspace/session-a.jsonl'
    setSessionLeafOverride(sessionFile, 'rewound-leaf')
    setSessionLeafOverride('/workspace/session-b.jsonl', 'other-leaf')

    applySessionEventToSessionLeafOverride({
      type: 'message', role: 'user', phase: 'end', sessionFile,
      sessionEntryId: 'new-prompt', seq: 1, workspaceId: '/workspace', timestamp: 1,
    } as AppEvent)

    expect(getSessionLeafOverride(sessionFile)).toBeUndefined()
    expect(getSessionLeafOverride('/workspace/session-b.jsonl')).toBe('other-leaf')
  })

  it.each([
    { type: 'message', role: 'user', phase: 'start' },
    { type: 'message', role: 'assistant', phase: 'end' },
    { type: 'run', phase: 'started' },
    { type: 'run', phase: 'idle', settled: false },
  ])('keeps the rewind until a new prompt is persisted or the run settles (%j)', (event) => {
    const sessionFile = '/workspace/session-a.jsonl'
    setSessionLeafOverride(sessionFile, 'rewound-leaf')

    applySessionEventToSessionLeafOverride({
      ...event, sessionFile, seq: 1, workspaceId: '/workspace', timestamp: 1,
    } as AppEvent)

    expect(getSessionLeafOverride(sessionFile)).toBe('rewound-leaf')
  })

  it('should_keep_override_for_other_sessions_and_nonterminal_events', () => {
    const sessionFile = '/workspace/session-a.jsonl'
    setSessionLeafOverride(sessionFile, 'rewound-leaf')

    applySessionEventToSessionLeafOverride({
      type: 'run',
      phase: 'running',
      sessionFile,
      seq: 1,
      workspaceId: '/workspace',
      timestamp: 1,
    } as AppEvent)
    applySessionEventToSessionLeafOverride({
      type: 'run',
      phase: 'idle',
      settled: true,
      sessionFile: '/workspace/session-b.jsonl',
      seq: 2,
      workspaceId: '/workspace',
      timestamp: 2,
    } as AppEvent)

    expect(getSessionLeafOverride(sessionFile)).toBe('rewound-leaf')
  })
})
