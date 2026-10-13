import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent'
import { handleLoadsession } from './worker-handlers-session'
import { st } from '../worker-runtime'

const originalState = { ...st }

afterEach(() => { Object.assign(st, originalState) })

describe('handleLoadsession', () => {
  function installSession() {
    const sessionManager = SessionManager.inMemory('/workspace')
    const previousLeaf = sessionManager.appendMessage({
      role: 'user', content: 'previous task', timestamp: 1,
    })
    const promptLeaf = sessionManager.appendMessage({
      role: 'user', content: 'new task', timestamp: 2,
    })
    const refreshContext = vi.fn()
    st.session = {
      sessionFile: '/sessions/active.jsonl',
      sessionManager,
      refreshContext,
      isStreaming: false,
      thinkingLevel: 'medium',
    } as unknown as AgentSession
    return { sessionManager, previousLeaf, promptLeaf, refreshContext }
  }

  it.each([
    { active: true, streaming: false, force: false },
    { active: false, streaming: true, force: false },
    { active: true, streaming: false, force: true },
  ])('preserves the running branch during a same-session rebind (%j)', async ({ active, streaming, force }) => {
    const { sessionManager, previousLeaf, promptLeaf, refreshContext } = installSession()
    st.agentTurnActive = active
    Object.assign(st.session!, { isStreaming: streaming })
    const reply = vi.fn()

    await handleLoadsession({ sessionFile: '/sessions/active.jsonl', leafId: previousLeaf, force }, reply)

    expect(sessionManager.getLeafId()).toBe(promptLeaf)
    expect(sessionManager.buildSessionContext().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'new task' }),
    ]))
    expect(refreshContext).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ type: 'loadSession-done', leafId: promptLeaf }))
  })

  it('preserves a running branch when the cached rewind points to an empty context', async () => {
    const { sessionManager, promptLeaf, refreshContext } = installSession()
    st.agentTurnActive = true

    await handleLoadsession({ sessionFile: '/sessions/active.jsonl', leafId: null }, vi.fn())

    expect(sessionManager.getLeafId()).toBe(promptLeaf)
    expect(refreshContext).not.toHaveBeenCalled()
  })

  it('still applies an explicit rewind to an idle session', async () => {
    const { sessionManager, previousLeaf, refreshContext } = installSession()
    st.agentTurnActive = false

    await handleLoadsession({ sessionFile: '/sessions/active.jsonl', leafId: previousLeaf }, vi.fn())

    expect(sessionManager.getLeafId()).toBe(previousLeaf)
    expect(refreshContext).toHaveBeenCalledOnce()
  })
})
