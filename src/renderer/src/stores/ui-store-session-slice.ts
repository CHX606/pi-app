import type { StateCreator } from 'zustand'
import {
  isDraftSessionKey,
  reconcileSessionMirror,
  seedSessionState,
  selectViewSession,
  sessionKeyOf,
} from '@renderer/stores/session-state'
import { applyRunStatePatch } from '@renderer/stores/session-ops'
import type { UIState } from '@renderer/stores/ui-store-types'

type StoreSet = (
  patch: Partial<UIState> | ((state: UIState) => Partial<UIState> | UIState),
) => void

type SessionSlice = Pick<
  UIState,
  'sessionStates' | 'viewSessionKey' | 'promoteViewSession' | 'setSessionRunState' | 'adoptViewSessionState'
>

type UIStateCreator = StateCreator<UIState, [['zustand/persist', unknown]], []>

/**
 * Every write — from inside the store or `useUIStore.setState` — goes through
 * `reconcileSessionMirror`, so `sessionStates[viewSessionKey]` and the legacy top-level session
 * fields never disagree.
 */
export const sessionMirror = (config: UIStateCreator): UIStateCreator => (set, get, api) => {
  type Partial_ = Partial<UIState> | UIState | ((state: UIState) => Partial<UIState> | UIState)
  const reconcile = (partial: Partial_): Partial<UIState> | null => {
    const prev = get()
    const patch = typeof partial === 'function' ? partial(prev) : partial
    if (!patch || patch === prev) return null
    return reconcileSessionMirror(prev, patch)
  }
  const savedSetState = api.setState
  api.setState = ((partial: Partial_, replace?: boolean) => {
    const patch = reconcile(partial)
    if (!patch) return
    return replace ? savedSetState(patch as UIState, true) : savedSetState(patch)
  }) as typeof api.setState
  const mirroredSet = ((partial: Partial_, replace?: boolean) => {
    const patch = reconcile(partial)
    if (!patch) return
    return replace ? set(patch as UIState, true) : set(patch)
  }) as typeof set
  return config(mirroredSet, get, api)
}

/** Per-session state map, the view pointer and the actions that write one session by key. */
export function createSessionSlice(set: StoreSet): SessionSlice {
  return {
    sessionStates: {},
    viewSessionKey: null,
    promoteViewSession: ({ sessionId, sessionFile }) =>
      set((s) => {
        const key = sessionKeyOf(sessionFile)
        if (!key) return s
        const draft = selectViewSession(s)
        return {
          pendingNewSessionPlaceholder: false,
          currentSessionId: sessionId,
          historySessionFile: sessionFile,
          historyTotalCount: 0,
          historyLoadedCount: 0,
          rewindTreeNodes: [],
          rewindWorkerBound: false,
          rewindLoadingTree: true,
          sessionStates: {
            ...s.sessionStates,
            [key]: {
              ...draft,
              key,
              historyTotalCount: 0,
              historyLoadedCount: 0,
              workerLiveSnapshot: { ...draft.workerLiveSnapshot, sessionId, sessionFile: key },
            },
          },
        }
      }),
    setSessionRunState: (session, patch) =>
      set((s) => {
        const key = s.sessionStates[session] || isDraftSessionKey(session) ? session : sessionKeyOf(session)
        if (!key) return s
        const entry = s.sessionStates[key] ?? seedSessionState(key, s)
        const { runState, model, thinkingLevel } = applyRunStatePatch(entry.runState, patch)
        const viewing = key === s.viewSessionKey
        return {
          sessionStates: { ...s.sessionStates, [key]: { ...entry, runState } },
          // The visible session's choices are the user's current defaults.
          ...(viewing && model !== undefined ? { lastModel: model } : {}),
          ...(viewing && thinkingLevel !== undefined ? { lastThinking: thinkingLevel } : {}),
        }
      }),
    adoptViewSessionState: (state) =>
      set((s) => {
        const key = s.viewSessionKey
        if (!key) return s
        return { sessionStates: { ...s.sessionStates, [key]: { ...state, key } } }
      }),
  }
}
