import { beforeEach, describe, expect, it, vi } from 'vitest'

// The switch path as the app runs it: the session id is set before the view moves to its file.
vi.mock('@renderer/lib/activate-workspace', async () => {
  const { useUIStore } = await import('@renderer/stores/ui-store')
  const switchSessionInPlace = vi.fn(async (sessionId: string, sessionFile: string) => {
    useUIStore.getState().setCurrentSession(sessionId)
    // The real switch stores the normalized path (forward slashes).
    useUIStore.setState({ currentSessionId: sessionId, historySessionFile: sessionFile.replace(/\\/g, '/') })
  })
  return { switchSessionInPlace, activateWorkspace: vi.fn() }
})
vi.mock('@renderer/lib/blank-session-transition', async () => {
  const { useUIStore } = await import('@renderer/stores/ui-store')
  return {
    enterBlankSession: vi.fn(() => useUIStore.setState({ historySessionFile: null, currentSessionId: '__pending_new__' })),
  }
})

import { useUIStore } from '@renderer/stores/ui-store'
import { splitActions, useSplitStore } from './split-store'
import { singleLayout } from './split-layout'

const ws = '/w'
const A = { sessionId: 'a', sessionFile: 'C:/w/a.jsonl', workspace: ws, title: 'FIRST hello' }
const B = { sessionId: 'b', sessionFile: 'C:/w/b.jsonl', workspace: ws, title: 'SECOND hello' }
const listed = [
  { sessionId: 'a', sessionFile: A.sessionFile, title: 'FIRST hello', updatedAt: 1, modelId: '' },
  { sessionId: 'b', sessionFile: B.sessionFile, title: 'SECOND hello', updatedAt: 2, modelId: '' },
]

beforeEach(() => {
  useSplitStore.setState(singleLayout(), true)
  useUIStore.setState({ currentWorkspace: ws, historySessionFile: null, currentSessionId: null, sessions: [] })
})

describe('split panes follow the focused session', () => {
  it('opens a sidebar session beside the current one without moving the current one', async () => {
    // FIRST created, then a new chat, then SECOND created — as the sidebar sees it.
    useUIStore.setState({ currentSessionId: 'a', historySessionFile: A.sessionFile })
    useUIStore.setState({ sessions: [listed[0]] })
    useUIStore.setState({ historySessionFile: null, currentSessionId: '__pending_new__' })
    useUIStore.setState({ currentSessionId: 'b', historySessionFile: B.sessionFile })
    useUIStore.setState({ sessions: listed })

    expect(useSplitStore.getState().panes.map((p) => p.session?.sessionFile)).toEqual([B.sessionFile])

    // The sidebar row spells the same file with Windows separators.
    splitActions.open({ ...A, sessionFile: 'C:\\w\\a.jsonl' })
    await vi.waitFor(() => expect(useUIStore.getState().historySessionFile).toBe(A.sessionFile))

    const { panes, activePaneId } = useSplitStore.getState()
    const active = panes.find((p) => p.id === activePaneId)
    const other = panes.find((p) => p.id !== activePaneId)
    expect(active?.session?.sessionFile.replace(/\\/g, '/')).toBe(A.sessionFile)
    expect(other?.session?.sessionFile).toBe(B.sessionFile)
  })
})
