import { dirname } from 'node:path'
import type { ContextStats } from '@shared/remote'
import { normalizeSessionFileKey } from '@shared/session-file-key'
import { normalizeCapabilities } from '@shared/capabilities'
import { findAdapterByTool } from '../../extension-compat/adapter-loader'
import { capabilityCatalog, capabilitySectionMap, capabilityToolFamilies } from '../capabilities/catalog'
import { configStore } from '../config-store'
import { getSessionLeafOverride, setSessionLeafOverride } from '../session-leaf-override'
import { workspaceFsListDir } from '../workspace-fs'
import { workspaceFsSearch } from '../workspace-file-search'
import { readGitDiffVsHead } from '../git-workspace'
import { sessionUsage } from '../usage-scan'
import { workerManager } from '../worker-manager'
import { noteBrowserTarget } from '../browser/targets'
import type { HostLiveState, HostModelList, RemoteHostPort } from './host-port'

/**
 * The parts of a RemoteHostPort that only need the worker pool, the config store and the
 * filesystem — shared by the desktop (`remote-host-electron.ts`) and the headless host
 * (`src/host/node-remote-host.ts`). Nothing here may change the desktop's foreground session.
 */

const MAX_REMEMBERED_CAPABILITIES = 300
const MODEL_GROUP_ORDER = { custom: 0, apiKey: 1, login: 2 } as const

/** Same scale as the desktop thinking picker (renderer `THINKING_LEVELS`). */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export const comparablePath = (p: string) => normalizeSessionFileKey(p).replace(/\/+$/, '').toLowerCase()

export function modelGroup(auth?: { source?: string; type?: string }): 'custom' | 'apiKey' | 'login' {
  if (auth?.type === 'oauth') return 'login'
  if (auth?.source === 'models_json_key' || auth?.source === 'models_json_command') return 'custom'
  return 'apiKey'
}

export type ListedModel = { id: string; name?: string; provider?: string; available?: boolean; contextWindow?: number; auth?: { source?: string; type?: string } }

const qualifiedId = (m: { id: string; provider?: string }) => (m.provider ? `${m.provider}/${m.id}` : m.id)

/** Models the phone may pick: available ones, custom first, then API keys, then sign-ins. */
export function toHostModelList(models: readonly ListedModel[], state: HostLiveState): HostModelList {
  return {
    models: models
      .filter((m) => m.available !== false)
      .map((m) => ({
        id: qualifiedId(m),
        ...(m.name ? { name: m.name } : {}),
        ...(m.provider ? { provider: m.provider } : {}),
        group: modelGroup(m.auth),
      }))
      // Stable within a group.
      .sort((a, b) => MODEL_GROUP_ORDER[a.group] - MODEL_GROUP_ORDER[b.group]),
    ...(state.model ? { current: state.model } : {}),
    ...(state.thinking ? { thinking: state.thinking } : {}),
    // A session without a bound worker reports no levels; offer the full scale like the desktop picker.
    availableThinking: state.availableThinking?.length ? state.availableThinking : [...THINKING_LEVELS],
  }
}

export type ContextPreview = { messageCount: number; estimatedChars: number; roleBreakdown: Array<{ role: string; chars: number }> }

/** Desktop composer metrics (chars / 4) with the current model's window when it is known. */
export function toContextStats(p: ContextPreview, current: string | undefined, models: readonly ListedModel[]): ContextStats {
  const tokens = (chars: number) => Math.round(chars / 4)
  const model = current ? models.find((m) => qualifiedId(m) === current || m.id === current) : undefined
  return {
    tokens: tokens(p.estimatedChars),
    ...(model?.contextWindow ? { window: Math.round(model.contextWindow) } : {}),
    messages: p.messageCount,
    breakdown: p.roleBreakdown.slice(0, 12).map((s) => ({ role: s.role, tokens: tokens(s.chars) })),
  }
}

type WorkerOps = Pick<
  RemoteHostPort,
  'liveState' | 'send' | 'abort' | 'rewind' | 'switchBranch' | 'clearQueue' | 'createSession' | 'fork' | 'respondUi' | 'cancelUi' | 'setThinking'
>

/**
 * Session operations on the session's own worker (never the foreground one). `invalidateSessions`
 * refreshes whatever caches the host keeps of a project's session list.
 */
export function workerSessionOps(deps: { invalidateSessions(projectId: string): void }): WorkerOps {
  const ops: WorkerOps = {
    async liveState(sessionFile) {
      const st = (await workerManager.getState(sessionFile).catch(() => ({}))) as {
        isStreaming?: boolean
        model?: string
        thinkingLevel?: string
        availableThinkingLevels?: string[]
      }
      return {
        running: !!st.isStreaming,
        ...(st.model ? { model: st.model } : {}),
        ...(st.thinkingLevel ? { thinking: st.thinkingLevel } : {}),
        ...(st.availableThinkingLevels ? { availableThinking: st.availableThinkingLevels } : {}),
      }
    },

    async send(sessionFile, text, mode, capabilities, projectId) {
      // Same sequence as the prompt handlers, minus the pending-bind bookkeeping that belongs
      // to the desktop UI: bind this session's worker (no foreground change), apply capabilities, send.
      // A session created remotely has a live worker but no file until its first reply:
      // re-loading it would read a missing header, so only cold sessions go through loadSession.
      if (!workerManager.hasLiveSessionWorker(sessionFile)) await workerManager.loadSession(sessionFile, { cwd: projectId })
      noteBrowserTarget(sessionFile, capabilities)
      await workerManager.setCapabilities(capabilitySectionMap(capabilities), capabilityToolFamilies(capabilities), sessionFile)
      if (mode === 'steer') await workerManager.steer(text, sessionFile)
      else if (mode === 'followUp') await workerManager.followUp(text, sessionFile)
      else await workerManager.sendPrompt(text, sessionFile)
    },

    abort: (sessionFile) => workerManager.abort(sessionFile),

    async rewind(sessionFile, anchor, projectId) {
      // Same as the desktop rewind, on this session's own worker (never the foreground one).
      if (!workerManager.hasLiveSessionWorker(sessionFile)) await workerManager.loadSession(sessionFile, { cwd: projectId })
      const r = await workerManager.navigateTree(anchor, { summarize: false, sessionFile })
      if (r.cancelled) throw new Error(r.error || 'rewind_cancelled')
      // pi keeps the leaf in memory only: persist it so history reads and later loads follow the branch.
      setSessionLeafOverride(sessionFile, r.leafId !== undefined ? r.leafId : anchor)
      return r.editorText ? { editorText: r.editorText } : {}
    },

    async switchBranch(sessionFile, leafId, projectId) {
      if (!workerManager.hasLiveSessionWorker(sessionFile)) await workerManager.loadSession(sessionFile, { cwd: projectId })
      const r = await workerManager.navigateTree(leafId, { summarize: false, sessionFile })
      if (r.cancelled) throw new Error(r.error || 'switch_cancelled')
      setSessionLeafOverride(sessionFile, r.leafId !== undefined ? r.leafId : leafId)
    },

    async fork(sessionFile, anchor, projectId) {
      // File-level branch (pi SessionManager), not the desktop fork: that one re-focuses the
      // foreground worker onto the fork, which would pull the desktop's view away.
      const { SessionManager } = await import('@earendil-works/pi-coding-agent')
      const sm = SessionManager.open(sessionFile, dirname(sessionFile), projectId)
      const entry = sm.getEntry(anchor) as { parentId?: string | null; message?: { role?: string; content?: unknown } } | undefined
      if (!entry || entry.message?.role !== 'user') throw new Error('entry not found')
      const content = entry.message.content
      const editorText = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: { type?: string; text?: string }) => (c?.type === 'text' ? c.text ?? '' : '')).join('') : ''
      // Forking before the first message is just a new session with that message to edit.
      const forked = entry.parentId ? sm.createBranchedSession(entry.parentId) : undefined
      const file = forked ?? (await ops.createSession(projectId))
      deps.invalidateSessions(projectId)
      return { sessionFile: file, ...(editorText ? { editorText } : {}) }
    },

    async clearQueue(sessionFile) {
      // Never spawn a worker just to read an empty queue.
      if (!workerManager.hasLiveSessionWorker(sessionFile)) return []
      const q = await workerManager.clearPromptQueue(sessionFile)
      return [...q.steering, ...q.followUp].filter(Boolean)
    },

    async createSession(projectId) {
      const result = await workerManager.newSessionInBackground(projectId)
      if (!result.sessionFile) throw new Error('session_not_created')
      deps.invalidateSessions(projectId)
      return result.sessionFile
    },

    async setThinking(sessionFile, level) {
      await workerManager.setThinkingLevel(level, sessionFile)
    },

    respondUi: (response) => workerManager.respondExtensionUI(response),
    cancelUi: (id) => workerManager.cancelExtensionUI(id, 'remote-cancel'),
  }
  return ops
}

/** The leaf the desktop tree shows: the persisted override, else the live worker's leaf. */
export async function sessionLeaf(sessionFile: string): Promise<string | null | undefined> {
  let leafId = getSessionLeafOverride(sessionFile)
  if (leafId === undefined && workerManager.hasLiveSessionWorker(sessionFile)) {
    const st = (await workerManager.getState(sessionFile).catch(() => null)) as { leafId?: string | null } | null
    if (st && 'leafId' in st) leafId = st.leafId ?? null
  }
  return leafId
}

type FileOps = Pick<RemoteHostPort, 'gitDiff' | 'sessionUsage' | 'listDir' | 'searchFiles' | 'capabilityCatalog' | 'sessionCapabilities' | 'setSessionCapabilities' | 'toolCardFor'>

/** Project files, git, usage and per-session capabilities (config store). */
export const projectFileOps: FileOps = {
  gitDiff: (projectId) => readGitDiffVsHead(projectId),

  async sessionUsage(sessionFile) {
    const u = sessionUsage(sessionFile)
    if (!u) return null
    const { reasoning: _r, ...wire } = u
    void _r
    return wire
  },

  async listDir(projectId, path, dotfiles) {
    const r = await workspaceFsListDir({ workspaceRoot: projectId, path, includeDotfiles: dotfiles })
    if (!r.ok) return null
    return {
      entries: r.entries.map((e) => ({ name: e.name, path: e.path, dir: e.isDirectory, size: e.size, mtime: e.mtimeMs == null ? undefined : Math.round(e.mtimeMs) })),
      truncated: r.truncated,
    }
  },

  async searchFiles(projectId, query) {
    const r = await workspaceFsSearch({ workspaceRoot: projectId, query, maxResults: 60 })
    return r.ok ? r.entries.map((e) => ({ name: e.name, path: e.path, dir: e.isDirectory })) : []
  },

  capabilityCatalog,
  sessionCapabilities: (sessionFile) => normalizeCapabilities(configStore.get('sessionCapabilities')?.[normalizeSessionFileKey(sessionFile)]),
  setSessionCapabilities(sessionFile, ids) {
    const key = normalizeSessionFileKey(sessionFile)
    const all = { ...(configStore.get('sessionCapabilities') || {}) }
    const caps = normalizeCapabilities(ids)
    delete all[key]
    if (caps.length) all[key] = caps
    configStore.set('sessionCapabilities', Object.fromEntries(Object.entries(all).slice(-MAX_REMEMBERED_CAPABILITIES)))
  },

  toolCardFor: (toolName, projectId) => findAdapterByTool(toolName, projectId)?.toolCard,
}
