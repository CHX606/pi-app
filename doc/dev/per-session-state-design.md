# Per-session renderer state — design

Status: proposal (no code changed yet) · Scope: `src/renderer/src/stores/*`, `src/renderer/src/lib/session-*`, live cache, composer/timeline readers · Author: design pass on 2026-10-19 against `f436c84` (v0.7.6)

## 1. Problem

pi Desktop runs one SDK worker per session (`WorkerManager` pool keyed by normalized `sessionFile`), but the renderer holds conversation state for **one** session at a time in top-level `useUIStore` fields. Everything else is an attempt to keep that single slot correct:

- a router (`resolveAppEventRoute`) that guesses whether an event belongs to "the visible session",
- a module-level copy of each session's view (`session-shell.ts` `views` Map),
- a second module-level copy of each *running* session (`live-session-timeline-cache.ts` `liveTimelines` Map),
- code that copies state **out** of the top-level slot on switch-away (`captureFocusFromUiStore`, `captureVisibleLiveSessionTimeline`) and **in** on switch-to (`bindViewToUiStore`, `loadHistoryItems`), deciding with "is it really running?" heuristics what to carry across.

Every copy-in/copy-out is a place where field X of session A survives into session B. The CHANGELOG shows this has been patched site by site since 0.4.5 (§6). The structural fix: **state lives under a session key from the moment it is created; the "visible session" is just a pointer; nothing is ever copied between sessions.**

## 2. Current data flow

```
worker (pi SDK)                 main                                   renderer
──────────────                  ────                                   ────────
baseEvent(): {sessionId,        forwardAppEvent():                     ipc:events → useUIStore.processEvent
  sessionFile: st.session        base.sessionFile ||= slot.sessionFile   └ applyAppEvent
  ?.sessionFile, workspaceId}    base.workspaceId ||= cwd                   ├ subagent reducer (before routing!)
                                 → webContents.send('ipc:events')           ├ resolveAppEventRoute(state, ev)
                                                                            │   'drop' | 'background' | 'visible'
                                                                            ├ background → applyBackgroundAppEvent
                                                                            │     → liveTimelines[file] (+ runtime map)
                                                                            └ visible → handlers mutate TOP-LEVEL
                                                                                  timelineItems / runState / queue …
switch A→B (session-shell.focusSessionSync / open-session):
  captureFocusFromUiStore()      top-level → views[A]
  captureVisibleLiveSessionTimeline() top-level → liveTimelines[A]   (only if "live")
  bindViewToUiStore(views[B])    views[B] ∪ liveTimelines[B] ∪ *top-level leftovers* → top-level
  hydrateSessionView(B) async    disk tail + liveTimelines[B] → views[B] → top-level (if still focused)
  loadHistoryItems(items)        keeps runState.model/thinkingLevel from whatever was there
```

### 2.1 Fields that are view-global today (one slot, shared by all sessions)

| Field (`UIState`) | Really belongs to | Where it leaks today |
|---|---|---|
| `timelineItems`, `streamingAssistantId` | session | copy-in/out in session-shell; `loadHistoryItems` merges "live" items when `keepRunning` heuristic is true |
| `runState` (status, activeRunId, activeTool, usage, toolCount, errorCount, startTime) | session | `bindViewToUiStore` spreads `...state.runState` (previous session) under the new one; `loadHistoryItems` keeps `runState` and only resets some keys |
| `runState.model`, `runState.thinkingLevel`, `availableThinkingLevels` | session (+ a *draft default* for not-yet-created sessions) | carried across switches; `materializePendingNewSession` reads `store.runState` to configure the new worker; `applyThinkingLevel` reads `historySessionFile` at call time |
| `optimisticPendingUserText`, `agentTurnBootstrapping`, `pendingTurnStage` | session (local outbound turn) | `visibleLocalTurn` logic in `bindViewToUiStore`; `reconcileSessionRuntimeIdle` clears only if still viewing |
| `pendingSteering`, `pendingFollowUp` | session | `queue` event writes top-level; `setPendingQueue` gates on `historySessionFile`; copied into both caches on capture |
| `fileChanges` | session | cleared on every focus; `file` events only applied when routed visible |
| `workerLiveSnapshot` | per worker = per session | single value; pinned to the *viewed* file by `handleRun`, `markViewIdle`, `bindViewToUiStore`, `applyLiveSnapshotToView` |
| `historySessionFile`, `currentSessionId`, `historyTotalCount`, `historyLoadedCount`, `historyLoading` | view pointer + per-session pagination | `historySessionFile` doubles as the identity of *everything* above |
| `composerWidget` | session (already cached in `extension-widget-cache`) | re-projected on `extension_widget` using `historySessionFile` |
| `composerPrefill` / composer DOM draft | session | draft is keyed via `composerDraftContextKey()` (a 5-step fallback ladder: ephemeral → pending → file → session → workspace) in a module Map |
| `subagentSessionGroup`, `rewind*` | view | reset on switch; OK as view state |

Already keyed per session (good, keep): `sessionRuntimeRunning`, `sessionWaitingUi`, `sessionSettledUnseen`, `sessionAttention`, `compactingSessions`, `toolExpandBySession`, `adapterWidgetExpandedBySession`, abort holds (`abort-ui-hold`), `extension-widget-cache`, `session-display-meta`. These are the precedent: each one was made per-session after a cross-talk bug (e.g. `compactingSessions` comment: "A 的压缩状态不得串到 B").

### 2.2 Three stores for one concept

| Store | Reactive | Keyed by | Written by |
|---|---|---|---|
| top-level `useUIStore` fields | yes | — (implicit `historySessionFile`) | visible-route handlers, optimistic send, history load, bind |
| `session-shell` `views` (max 12, LRU) | no | normalized file | capture on switch-away, hydrate |
| `live-session-timeline-cache` `liveTimelines` (bg cap 200 items) | no | normalized file | background-route events, capture of running visible session, optimistic send |

Two independent reducers implement "apply a message/tool event to a timeline": `apply-app-event-message.ts`/`-tool.ts` (top-level) and `applyMessage`/`applyTool` in `live-session-timeline-cache.ts`. They have drifted (the background one has its own delta batching, `ensureStreamingAssistant`, overlap tracking). Switch-back correctness depends on merging their outputs (`mergeLiveIntoItems`, `pickRicherTimeline`, `timelineRichnessScore`), which is where #99 and the 0.7.4 "own message disappeared" bugs lived.

## 3. Every place that routes or attributes by heuristic

R = routing decision, A = attribution fallback (`x || viewFile`), S = snapshot pinning.

| # | Location | Kind | Heuristic |
|---|---|---|---|
| 1 | `stores/apply-app-event-route.ts` `resolveAppEventRoute` | R | 8-branch decision on `historySessionFile`, `currentSessionId`, `workerLiveSnapshot.{sessionFile,sessionId}`, placeholder ids; **final fallback `return 'visible'`** for events without `sessionFile` |
| 2 | `stores/apply-app-event.ts` run / queue / agent_error / completion cases | A | `eventSessionFile(event) \|\| api.get().historySessionFile` decides which runtime flag / live cache / settled flag to touch |
| 3 | `stores/apply-app-event.ts` top | R | `reduceSubagentSessionGroupToolEvent` runs on **every** tool event before routing, against the view's group |
| 4 | `stores/apply-app-event.ts` `extension_widget` | A | re-projects `getSessionComposerWidget(historySessionFile)` |
| 5 | `stores/apply-app-event-run.ts` `handleRun` started/running | R+S | second routing check (`isViewingWorkerBoundSession(viewFile, evFile)`), then pins `workerLiveSnapshot.sessionFile = viewFile` |
| 6 | `apply-app-event-run.ts` `markViewIdle`, failed branch | S | writes snapshot for `viewFile ?? liveSnap.sessionFile` |
| 7 | `apply-app-event-run.ts` `state` phase | R+A | applies model/thinking "from the viewed session (or unscoped events)"; `commitSessionDisplayMeta(viewFile ?? evFile)` |
| 8 | `apply-app-event-run.ts` idle | A | `eventSessionFile(event) \|\| historySessionFile` for compaction clear; `shouldSuppressPrematureRunIdle` reads *view* optimistic markers for an event that may be another session's |
| 9 | `stores/apply-app-event-background.ts` | R | events with no `sessionFile` are silently dropped in the background path |
| 10 | `ui-store.ts` `setPendingQueue` | A | abort-ignore check against `historySessionFile` |
| 11 | `ui-store.ts` `loadHistoryItems` | R | `keepRunning = runtimeHere \|\| localTurn \|\| (viewingWorkerSession && snap running)` decides whether to merge the *current top-level* timeline into the incoming history; preserves `runState.model/thinkingLevel` |
| 12 | `ui-store-runtime-slice.ts` `reconcileSessionRuntimeIdle`, `markSessionSettled` | A | branch on `sessionFilesEqual(historySessionFile, file)` |
| 13 | `ui-store-shell-slice.ts` `setToolCallExpanded` / `getToolCallExpanded` | A | key = `historySessionFile \|\| '__none__'` |
| 14 | `lib/session-shell.ts` `resolveRunUI`, `bindViewToUiStore`, `focusSessionSync`, `hydrateSessionView` | R+S | "strongest running signal" across runtime map, live cache, view cache, `visibleLocalTurn`; `...state.runState` spread from previous session; writes `workerLiveSnapshot` |
| 15 | `lib/capture-live-session-timeline.ts` | R | decides "live" from 6 signals incl. bare `runState.status`; warms *worker's* cache if view≠worker |
| 16 | `lib/session-worker-sync.ts` `applyLiveSnapshotToView`, `syncViewRunStateFromWorkerSnapshot`, `composerTurnActive`, `canAbortWorkerTurn` | R+S | accept/ignore a polled snapshot depending on whether it "is for the viewed session"; unscoped running snaps ignored |
| 17 | `lib/blank-session-transition.ts` | S | resets most of the slot but **keeps** `runState.model/thinkingLevel/usage`, `lastModel`, `lastThinking` |
| 18 | `lib/new-session.ts` `materializePendingNewSession` | R | `ownsView` = nav token ∧ 3 field equality; configures the new worker from `store.runState` (the snapshot captured at call time) |
| 19 | `features/composer/thinking-level-actions.ts` `applyThinkingLevel` | A | optimistic `setRunState` on the top-level slot, target = `historySessionFile` at call time; rollback guarded by re-reading the view |
| 20 | `features/composer/composer-transient-draft.ts` `composerDraftContextKey` | A | 5-step fallback key ladder |
| 21 | `lib/optimistic-send.ts` | A | appends to top-level timeline; attributes to `historySessionFile` if set, else patched later via `bindOptimisticOutgoingToSession` token |
| 22 | main `worker-manager.ts` `forwardAppEvent` | A | `sessionFile ||= slot.sessionFile` — fine, but `slot.sessionFile` is `null` for a fresh slot until `remapSessionWorkerSlot`, and `fromPoolKey` is not forwarded |

## 4. Proposed shape

### 4.1 Session key

```ts
// lib/session-key.ts
export type SessionKey = string & { readonly __brand: 'SessionKey' }
export function sessionKeyOf(sessionFile: string): SessionKey  // normalizeSessionFileKey, throws on empty
export function draftKey(kind: 'pending' | 'ephemeral', workspace: string | null): SessionKey // 'draft:pending:<ws>'
```

- The canonical key is the **normalized `sessionFile`**. It already is the routing key in main (`normalizeSessionKey`), the pool key, and every per-session map in the renderer. `session.new` returns `sessionFile` synchronously (`new-session.ts` throws if absent), and worker `baseEvent()` stamps `st.session?.sessionFile`, so every event emitted after a session exists carries it.
- `sessionId` is **metadata**, never a routing key (ids are placeholders like `__pending_new__` in the renderer and differ in meaning across fork/clone).
- A blank composer (new-chat placeholder, ephemeral sandbox) gets a **draft key**. Draft state holds only composer draft + chosen model/thinking. When `session.new` resolves, the draft entry is **moved** (`promoteDraft(draftKey, realKey)`) — an explicit, single transition instead of `ownsView` field comparisons.

### 4.2 Store shape

```ts
interface SessionState {
  key: SessionKey
  sessionId: string | null
  workspaceId: string | null
  timeline: { items: TimelineItem[]; streamingAssistantId: string | null; persistedEntryOverlap: string[] }
  history: { total: number; loaded: number; phase: 'empty' | 'hydrating' | 'ready' | 'error' }
  run: RunState                       // status/activeRunId/activeTool/usage/counts — no model/thinking
  config: { model?: string; thinkingLevel?: string; availableThinkingLevels?: string[]; pending?: { thinkingLevel?: string; model?: string } }
  outbound: { optimisticUserText: string | null; bootstrapping: boolean; stage: 'starting' | 'sending' | null }
  queue: { steering: string[]; followUp: string[] }
  fileChanges: FileChange[]
  worker: { status: 'idle' | 'running' | 'failed' | 'unknown'; sessionId: string | null }  // replaces workerLiveSnapshot
  composer: { draft: Segment[] | null; prefill: { text: string; mode: 'replace' | 'append' } | null; widget: AdapterWidgetProjection | null }
  ui: { toolExpand: Record<string, boolean>; widgetExpanded: boolean }
  lastFocusedAt: number
}

interface UIState {
  sessions: Record<SessionKey, SessionState>     // name clash: existing `sessions` (sidebar list) → rename `sessionList`
  viewSessionKey: SessionKey | null               // the ONLY "which session is visible" value
  defaults: { model: string | null; thinkingLevel: string | null }  // was lastModel/lastThinking
  // …workspace, shell/layout, pickers, runtime flags (sessionRuntimeRunning etc. stay; later derived from sessions[k].run)
}
```

Rules:

1. **Writers take a key.** Every mutator is `(key, patch)`; no mutator reads `viewSessionKey` to find its target. Event handlers become pure reducers `reduceSessionEvent(s: SessionState, ev) => SessionState`, shared by visible and background sessions (one implementation instead of `apply-app-event-*` + `live-session-timeline-cache.applyMessage/applyTool`).
2. **Readers go through selectors.** `useViewSession(sel)` = `useUIStore(s => { const v = s.viewSessionKey && s.sessions[s.viewSessionKey]; return v ? sel(v) : sel(EMPTY_SESSION) })`. `timeline.tsx`, composer, `useSessionChrome`, pickers, metrics read via this. Switching sessions = changing one pointer; React re-renders from a different object; nothing is copied.
3. **No copy between keys** except `promoteDraft` (draft → real) and fork/clone, which create a new entry explicitly.
4. **Eviction**, not capture: idle, unfocused entries beyond `MAX_SESSION_VIEWS` drop `timeline.items` back to `history.phase='empty'` (re-hydrate from disk); running entries are pinned. Background entries keep the existing 200-item cap on live items.
5. **Disk is authority after settle**: on `run idle/failed/cancelled` for key k, mark `history.phase` stale (the current `markSessionDiskAuthoritative`), so focusing k re-reads the tail and merges — same as today, but against k's own state only.
6. **Model/thinking are per-session config.** The pickers write `sessions[view].config` and send IPC with that key captured at click time; a draft's choice lives on the draft entry and is applied by `promoteDraft` — never read from whatever the top-level `runState` happens to be.

Performance: streaming deltas currently batch via `ui-store-stream` rAF into top-level `timelineItems`. Keep the same batching, keyed by session (the live cache already does this for background). Background sessions update their own entry; `useViewSession` selectors only re-render when the *viewed* entry changes identity, so a busy background session costs a store notify but no React work for view components. If profiling shows notify cost matters, background entries can buffer outside the store and flush at most every ~250 ms.

### 4.3 Routing events to a key (no fallback-to-visible)

```ts
function routeEvent(ev: SessionScopedAppEvent, s: UIState): SessionKey | null {
  if (ev.sessionFile) return sessionKeyOf(ev.sessionFile)
  return null   // unattributable → dropped + counted (dev log / alertTrace), never 'visible'
}
```

To make `null` rare-to-never:

- **Main stamps every session event.** In `forwardAppEvent`, after `||= slot.sessionFile`, if still missing and the slot is a fresh pool slot, stamp from the worker's own `init-done`/`session.new` reply (main already learns the file in `newSession*` before `remapSessionWorkerSlot`). Add a main-side unit test: every `app-event` forwarded for a slot with a session has `sessionFile`. Also forward `poolKey` for diagnostics.
- Worker events emitted before any session exists (e.g. init) are not session events; they should be typed as such or dropped.
- Workspace mismatch no longer matters for routing: an event for key k updates `sessions[k]` regardless of which workspace is shown (it already goes to the background cache today).

Consequences: `resolveAppEventRoute`, `isViewingWorkerBoundSession` checks inside handlers, `eventSessionFile(ev) || historySessionFile`, `markViewIdle`, the second check in `handleRun`, and `shouldSuppressPrematureRunIdle` reading view markers all disappear — the reducer gets `sessions[k]` and reads *its* outbound markers.

Polling (`fetchWorkerLiveSnapshot`) already requests by `sessionFile`; its result is applied to `sessions[requested].worker`, never to "the view". The "unscoped running snap is untrusted" branch becomes unrepresentable.

## 5. Migration plan (PR-sized, `npm run test:unit` green after each)

Strategy: introduce the keyed map **beside** the top-level fields, make it authoritative one field-group at a time, keep the old top-level fields as a *derived mirror* of `sessions[viewSessionKey]` (written by one function, `projectViewMirror()`) until all readers are migrated, then delete the mirror. Existing tests that assert top-level fields keep passing through the mirror.

### PR 1 — Kill fallback-to-visible (small, recommended first)

Scope: routing only, no store-shape change.

- main `forwardAppEvent`: guarantee `sessionFile` on every session-scoped event (stamp from slot; for a slot with `sessionFile == null`, track the file from the `newSession` reply before remap). Test in `src/main/__tests__/worker-manager-session-isolation.test.ts`.
- `resolveAppEventRoute`: if `!event.sessionFile` → `'drop'` (with `alertTrace('unscoped app event', {type, phase})`). Remove the `sessionId` branches and the trailing `return 'visible'`. Delete the "first send viewFile null" branch only if PR 1 also makes `new-session.ts` set `historySessionFile` before sending (it already calls `setHistoryMeta(0,0,sessionFile)` in `ownsView`) — otherwise keep that one branch, keyed on file equality, not snapshot.
- `apply-app-event.ts`: replace every `eventSessionFile(event) || api.get().historySessionFile` with `eventSessionFile(event)!` (now guaranteed by the route).
- Tests: update `apply-app-event-route.test.ts` (the unscoped case now expects `'drop'`; add "unscoped event while viewing the worker's own session → drop"); add a test that an unscoped `run running` after switching A→B leaves B's `runState`/runtime map untouched.

Prevents: the whole class "A's unscoped run events re-light B after switch" (comment in route file; 0.5.7 "停止按钮和运行标记不再跨会话复活"; 0.7.6 "切换会话后仍显示上一个会话的运行状态、发送被阻塞"). Risk: an event type that the worker emits without a session would silently disappear — the `alertTrace` + main-side test catches that.

Size: ~4 files, ~80 lines + tests. Does not touch the store shape, so it is safe to land before the larger work and shrinks the surface every later PR must reason about.

### PR 2 — `SessionKey` + `sessions` map skeleton + view pointer

- Add `lib/session-key.ts`; rename sidebar `sessions` → `sessionList` (mechanical).
- Add `sessions: Record<SessionKey, SessionState>` and `viewSessionKey`; `setViewSession(key)` sets the pointer and `historySessionFile`/`currentSessionId` as mirrors.
- Add `useViewSession(selector)` and `selectViewSession(state)`.
- No behavior change; tests: new unit tests for the reducers/selectors only.

### PR 3 — Run state per session (run/worker/outbound groups)

- `sessions[k].run`, `.worker`, `.outbound` become authoritative. `handleRun` → `reduceRun(sessions[k], ev)`; same reducer used for background (delete the `run` branch of `applyBackgroundAppEvent`).
- `sessionRuntimeRunning[k]` becomes derived from `sessions[k].run.status` (keep the map as a selector-backed mirror for the sidebar).
- `useSessionChrome`, `composerTurnActive`, `canAbortWorkerTurn` read `sessions[view]` — `workerLiveSnapshot` heuristics (#16) go away; `applyLiveSnapshotToView` becomes `applyWorkerSnapshot(k, snap)`.
- Top-level `runState`, `workerLiveSnapshot`, `optimisticPendingUserText`, `agentTurnBootstrapping` become mirrors via `projectViewMirror()`.
- Prevents: wrong run state after switch / send blocked (0.7.6), stop button resurrecting (0.5.7), run state out of sync while previewing (0.4.11), `loadHistoryItems` re-lighting "running" from residual `runState` (comment in `ui-store.ts`).

### PR 4 — Model / thinking per session + draft entries

- `sessions[k].config`; pickers and `applyThinkingLevel` capture `k = viewSessionKey` at click time and write `sessions[k]`; `run state` events update `sessions[evKey].config` regardless of view.
- Draft keys for pending/ephemeral blank sessions; `materializePendingNewSession` calls `promoteDraft(draftKey, sessionKeyOf(file))` and configures the worker from the **draft entry**, not `store.runState`. `ownsView` collapses to "is `viewSessionKey` still `draftKey`?".
- `blank-session-transition` stops resetting/keeping a shared `runState`; it just points the view at a fresh draft (seeded from `defaults`).
- Prevents: 0.7.6 "在新会话中调整强度不再误改后台运行中的会话", "手动选择的强度不再被延迟返回的默认值覆盖"; 0.5.3 "切换 session 后 Composer 模型与上下文不刷新"; 0.5.0 model picker overwritten by defaults.

### PR 5 — Queue, file changes, composer widget, tool expand, composer draft

- `queue`, `file`, `extension_widget` events reduce into `sessions[k]`; `setPendingQueue` / abort-ignore keyed by k.
- `toolExpandBySession`, `adapterWidgetExpandedBySession` fold into `sessions[k].ui`; `composer-transient-draft` Map and `composerPrefill` move to `sessions[k].composer` (draft keys cover the pending/ephemeral cases, replacing the 5-step key ladder).
- Prevents: queued messages shown in / restored to the wrong session; composer draft or line-ref prefill landing in another session; widget of A shown on B.

### PR 6 — Timeline per session; one reducer; delete the two caches

The big one; may split into 6a (reducer unification) and 6b (store swap).

- 6a: extract `reduceTimelineEvent(timeline, ev)` from `apply-app-event-message/tool/compaction/slash/agent-error`, make `live-session-timeline-cache.applyMessage/applyTool` call it; prove equivalence with the existing `apply-app-event-tool-*`, `live-session-timeline-cache`, `background-turn-switch-back` tests.
- 6b: `sessions[k].timeline` is authoritative for all keys; `timeline.tsx` reads via `useViewSession`. Delete `captureFocusFromUiStore`, `captureVisibleLiveSessionTimeline`, `bindViewToUiStore`, `views` Map, `liveTimelines` Map, `pickRicherTimeline`. `focusSessionSync` = `setViewSession(k)` + `hydrate(k)` if `history.phase !== 'ready'`. `hydrate(k)` merges disk tail into `sessions[k].timeline` (existing `mergeLiveTimelineWithHistoryTail`) and never looks at the view.
- Prevents: #99 (switch-back shows stale content — the merge was between three stores with a 120 s slice cache; now one store per key, disk refresh merges into the same entry); 0.7.6 "创建新对话或运行中刷新历史时串入其他会话的内容"; 0.7.4 "长回复进行中切换会话，回来后自己发的消息不见了…切换会话后残留上一个会话的历史"; 0.5.1 lost optimistic message on switch; 0.4.11 streaming content lost/misplaced.

### PR 7 — Remove mirrors

- Delete top-level `timelineItems`, `runState`, `streamingAssistantId`, `pendingSteering/FollowUp`, `fileChanges`, `workerLiveSnapshot`, `optimisticPendingUserText`, `agentTurnBootstrapping`, `composerWidget`, `historySessionFile`, `currentSessionId` and `projectViewMirror`. Remaining test fixtures that set top-level fields are migrated to `sessions[k]` helpers (`makeSessionState()` test util introduced in PR 2).
- Add an ESLint `no-restricted-syntax` rule forbidding `historySessionFile` as a mutation target outside `setViewSession`.

## 6. Bugs each step structurally prevents

| Past bug (CHANGELOG / issue) | Root cause class | Fixed by |
|---|---|---|
| 0.7.6 切换会话后仍显示上一个会话的运行状态、发送被阻塞 | shared `runState` + unscoped events default visible | PR 1, PR 3 |
| 0.7.6 创建新对话或运行中刷新历史时串入其他会话的内容 | top-level timeline reused across sessions; `loadHistoryItems` merges current slot | PR 4 (draft), PR 6 |
| 0.7.6 回到已回退的会话后丢失当前分支 | cache merge picks wrong copy (`pickRicherTimeline`) | PR 6 |
| 0.7.6 新会话中调整强度误改后台运行中的会话；默认值覆盖手动选择 | thinking level on shared `runState`, target resolved late | PR 4 |
| 0.7.4 长回复中切换会话后自己发的消息不见；加载历史丢正在输出的消息；残留上一个会话的历史 | copy-in/out between three stores | PR 6 |
| #99 / 0.6.0 后台会话完成后切回显示旧内容 | bg live cache vs slice cache vs view cache merge | PR 6 (disk refresh into the one keyed entry; `history.phase` stale on settle) |
| 0.6.0 会话身份错位：分叉/克隆等待期间切换，结果分配给新选中的会话 | async result applied to "current view" | PR 4 (`promoteDraft`/explicit key captured at start) |
| 0.5.7 停止按钮和运行标记跨会话复活；瞬时查询失败误判 idle | `workerLiveSnapshot` single slot + view pinning | PR 1, PR 3 |
| 0.5.8 后台扩展问答清不掉 / 0.5.7 多 Worker Extension UI 串话 | extension UI keyed by foreground | partially PR 3 (`sessions[k].worker`); extension-ui-store is out of scope (already per-request) |
| 0.5.3 切换后 Composer 模型与上下文不刷新 | model on shared `runState` | PR 4 |
| 0.5.1 流式输出时切换会话丢失刚发的消息 | optimistic rows only in top-level slot | PR 3 (`outbound` per key), PR 6 |
| 0.4.11 预览其它会话时后台运行状态与时间线不同步、切回后流式内容丢失或错位 | two reducers (visible vs background) | PR 6a |
| #94 输入框偶发无法输入 | Windows native confirm dialog stealing focus — **not** a state-shape bug | not addressed; PR 5 only removes draft-key churn on switch, which reduces composer remount paths but is not the fix |

## 7. Risks and open questions

- **Event volume**: background streaming now writes the store. Mitigated by keyed rAF batching (exists today for bg in the live cache); measure with `timeline-stream-perf.test.tsx` before PR 6b.
- **Memory**: unbounded `sessions` map. Same LRU policy as today (12 views, running pinned), applied to `timeline.items` only; the small per-session scalars can stay.
- **`sessionFile` renames** (fork/clone `remapSessionWorkerSlot`, rewind branch change): need an explicit `renameSessionKey(old, new)` reducer rather than "the next event will carry the new file". Audit `session-fork.ts`, `session-rewind.ts`.
- **Split view** (`features/split/split-store.ts`) keeps several panes but shows only the active one: it reads `historySessionFile`/`currentSessionId` and calls `switchSessionInPlace` when a pane is activated, so every pane change is a full session switch. It must move to `viewSessionKey` in PR 7 at the latest; afterwards panes could render `sessions[paneKey]` side by side (a follow-up, not part of this plan).
- **Remote / mobile projector** (`src/main/remote/projector.ts`) builds its own state in main; unaffected, but its tests are a good reference for a per-session reducer.

## 8. Recommended first PR

**PR 1 — "Route app events only by `sessionFile`; never default to visible".** It is ~4 files, needs no store migration, removes the single most-patched heuristic (`resolveAppEventRoute`'s fallback plus the `|| historySessionFile` attribution in `apply-app-event.ts`), and turns any remaining unscoped event into a visible trace instead of silent cross-talk. Acceptance: main test proving every forwarded session event carries `sessionFile`; route tests updated (`unscoped → drop`); a regression test "unscoped `run running` after switching A→B does not change B"; `npm run test:unit` green.
