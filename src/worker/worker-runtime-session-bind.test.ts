import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../extension-compat/adapter-loader', () => ({
  prepareAdapterCatalog: vi.fn(async () => {}),
  installAdapterCatalog: vi.fn(),
}))
vi.mock('./worker-transport', () => ({ sendToMain: vi.fn() }))
vi.mock('./desktop-widget-host', () => ({
  createDesktopWidgetHost: () => ({ dispose: vi.fn(), reconstructFromBranch: vi.fn() }),
}))

import { st, switchOrLoadSession } from './worker-runtime'

const originalState = { ...st }

beforeEach(() => { Object.assign(st, originalState) })
afterEach(() => { Object.assign(st, originalState) })

describe('initial worker session binding', () => {
  it('opens history directly without invoking the blank session switch guard', async () => {
    const switchSession = vi.fn(async () => ({ cancelled: true }))
    const dispose = vi.fn(async () => {})
    st.runtime = {
      switchSession, dispose,
      setBeforeSessionInvalidate: vi.fn(), setRebindSession: vi.fn(),
    } as never
    st.promptSent = false
    st.uiBridge = { uiContext: {}, attachWidgetHost: vi.fn() } as never
    const sessionManager = { getCwd: () => '/workspace', branch: vi.fn() }
    const session = {
      sessionId: 'b', sessionFile: '/sessions/b.jsonl', sessionManager,
      bindExtensions: vi.fn(async () => {}), subscribe: vi.fn(() => vi.fn()),
    }
    const runtime = {
      session, services: {},
      setBeforeSessionInvalidate: vi.fn(), setRebindSession: vi.fn(),
    }
    const open = vi.fn(() => sessionManager)
    const createRuntime = vi.fn(async () => runtime)
    st.sdk = {
      getAgentDir: () => '/agent', SessionManager: { open },
      createAgentSessionRuntime: createRuntime,
    } as never

    await switchOrLoadSession('/sessions/b.jsonl', 'leaf-b')

    expect(switchSession).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith('/sessions/b.jsonl')
    expect(sessionManager.branch).toHaveBeenCalledWith('leaf-b')
    expect(createRuntime).toHaveBeenCalledWith(expect.any(Function), {
      cwd: '/workspace', agentDir: '/agent', sessionManager,
    })
    expect(st.session).toBe(session)
    expect(session.bindExtensions).toHaveBeenCalledOnce()
  })

  it('preserves extension cancellation for an explicit switch from a used session', async () => {
    const switchSession = vi.fn(async () => ({ cancelled: true }))
    st.runtime = { switchSession } as never
    st.sdk = {} as never
    st.promptSent = true

    await expect(switchOrLoadSession('/sessions/b.jsonl')).rejects.toThrow('SESSION_SWITCH_CANCELLED')
    expect(switchSession).toHaveBeenCalledWith('/sessions/b.jsonl')
  })
})
