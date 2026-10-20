import { app, safeStorage } from 'electron'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { hostname } from 'node:os'
import type { CacheWarming } from '@shared/remote'
import { wslPathToWindows } from '@shared/wsl-path'
import { readRemoteAttachment, writeRemoteAttachment } from './clipboard-temp-images'
import { configStore } from './config-store'
import { scanStaticSlashCommands } from './commands-catalog'
import { probeExtensionsShared } from './extension-probe-cache'
import { getDesktopSkillOverrides, isSkillEnabled } from './pi-skill-overrides'
import { awaitWslVm } from './wsl/wsl-env'
import { isSandboxWorkspacePath, sandboxLabel } from './sandbox-workspaces'
import { invokeHandler } from './ipc/registry'
import type { HostModelList, HostSessionHistory, HostSessionRow, HostTimelineItem, RemoteHostPort } from './remote/host-port'
import {
  comparablePath as comparable,
  projectFileOps,
  sessionLeaf,
  toContextStats,
  toHostModelList,
  workerSessionOps,
  type ContextPreview,
  type ListedModel,
} from './remote/host-port-common'
import { sessionPreviewProcess } from './session-preview-process'
import { readSessionMetaFromFile } from './session-file-meta'
import { getTrustedWorkspaceRoot } from './trusted-workspace'
import { getMainWindow } from './window'
import { getAgentRuntimeConfig } from './wsl/runtime-config'

/**
 * Electron implementation of the remote gateway's port. Reads go through the same registered
 * IPC handlers the renderer uses (authorization, WSL mapping, preview process); writes call
 * workerManager with an explicit sessionFile (shared with the headless host, see
 * `remote/host-port-common.ts`). Nothing here touches the desktop's foreground session, pending
 * bind or current workspace.
 */

const HOST_KEY_FILE = 'remote-host.key'
const HOST_KEY_FILE_MARK = 'file:remote-host.key'

function safeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

type ListedSession = { sessionFile: string; title: string; createdAt: number; updatedAt: number; firstMessage?: string }

function trustedProjects(): string[] {
  const all = [getTrustedWorkspaceRoot(), ...(configStore.get('recentProjects') || [])].filter((p): p is string => !!p)
  const seen = new Set<string>()
  return all.filter((p) => {
    const k = comparable(p)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function sendToRenderer(channel: string, payload: unknown): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

export function createElectronRemoteHost(): RemoteHostPort {
  const sessionOps = workerSessionOps({
    invalidateSessions: (projectId) => void sessionPreviewProcess.invalidateListSessions(projectId).catch(() => {}),
  })
  const listAvailable = () => invokeHandler<{ models?: ListedModel[] }>('ipc:model.list', { scope: 'available' })

  return {
    ...sessionOps,
    ...projectFileOps,
    hostName: () => hostname(),
    appVersion: () => app.getVersion(),
    trustedProjects,

    async listSessions(projectId: string): Promise<HostSessionRow[]> {
      const r = await invokeHandler<{ sessions?: ListedSession[] }>('ipc:session.list', { workspaceId: projectId })
      return (r.sessions ?? []).map((s) => ({
        sessionFile: s.sessionFile,
        projectId,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        ...(s.firstMessage ? { firstMessage: s.firstMessage } : {}),
      }))
    },

    projectInfo(path: string) {
      if (!isSandboxWorkspacePath(path)) return {}
      const label = sandboxLabel(path)
      return { temporary: true, ...(label ? { label } : {}) }
    },

    async sessionProject(sessionFile: string): Promise<string | null> {
      const cwd = (await readSessionMetaFromFile(sessionFile).catch(() => null))?.cwd
      if (!cwd) return null
      const runtime = getAgentRuntimeConfig()
      const candidates = [cwd]
      if (runtime.mode === 'wsl' && runtime.distro) candidates.push(wslPathToWindows(runtime.distro, cwd))
      const trusted = trustedProjects()
      for (const c of candidates) {
        const hit = trusted.find((t) => comparable(t) === comparable(c))
        if (hit) return hit
      }
      return cwd
    },

    async readHistory(projectId: string, sessionFile: string): Promise<HostSessionHistory> {
      const r = await invokeHandler<{ items?: HostTimelineItem[]; error?: string; sessionMeta?: { model?: string; thinkingLevel?: string } }>(
        'ipc:session.getMessages',
        { sessionFile, workspaceId: projectId },
      )
      if (r.error) throw new Error(r.error)
      return { items: r.items ?? [], model: r.sessionMeta?.model, thinking: r.sessionMeta?.thinkingLevel }
    },

    async sessionTree(sessionFile: string, projectId: string) {
      const r = await sessionPreviewProcess.getTree({ sessionFile, cwd: projectId, leafId: await sessionLeaf(sessionFile) })
      return { rows: r.nodes, leafId: r.leafId }
    },

    async listModels(sessionFile: string): Promise<HostModelList> {
      const [list, state] = await Promise.all([listAvailable(), sessionOps.liveState(sessionFile)])
      return toHostModelList(list.models ?? [], state)
    },

    async setModel(sessionFile: string, modelId: string): Promise<string> {
      const r = await invokeHandler<{ modelId?: string }>('ipc:model.set', { sessionFile, modelId })
      return r.modelId || modelId
    },

    async saveAttachment(bytes: Uint8Array, name: string): Promise<string> {
      return writeRemoteAttachment(bytes, name)
    },

    async readAttachment(path: string) {
      return readRemoteAttachment(path)
    },

    dismissDesktopUi: (id: string) => sendToRenderer('ipc:extension-ui-dismiss', { type: 'extension-ui-dismiss', id, reason: 'remote-answered' }),

    async listCommands(projectId: string) {
      // Same catalog the desktop composer shows before a worker is bound: disk prompts, skills
      // (minus the ones disabled in settings) and extension commands for that project.
      await awaitWslVm()
      const overrides = getDesktopSkillOverrides()
      return scanStaticSlashCommands(projectId, await probeExtensionsShared(projectId))
        .filter((c) => c.category !== 'skill' || isSkillEnabled(String(c.id || c.name).replace(/^\/?skill:/, ''), c.source?.path || c.source?.filePath, overrides))
        .map((c) => ({ name: c.name, description: c.description || undefined, category: c.category }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },

    async contextStats(sessionFile: string, projectId: string) {
      const [r, state, list] = await Promise.all([
        invokeHandler<{ preview?: ContextPreview | null }>('ipc:context.preview', { sessionFile, workspaceId: projectId }),
        sessionOps.liveState(sessionFile),
        listAvailable().catch(() => ({ models: [] as ListedModel[] })),
      ])
      return r.preview ? toContextStats(r.preview, state.model, list.models ?? []) : null
    },

    async getCacheWarming(): Promise<CacheWarming> {
      const r = await invokeHandler<{ settings?: { cacheWarming?: string } | null }>('ipc:pi.settings.get')
      const v = r.settings?.cacheWarming
      return v === 'off' || v === 'idle' || v === 'streaming' ? v : 'streaming'
    },

    async setCacheWarming(mode: CacheWarming): Promise<CacheWarming> {
      const r = await invokeHandler<{ ok?: boolean; error?: string }>('ipc:pi.settings.set', { patch: { cacheWarming: mode } })
      if (r.ok === false) throw new Error(r.error || 'pi_settings_write_failed')
      return mode
    },

    notifySessionsChanged(projectId) {
      void sessionPreviewProcess.invalidateListSessions(projectId).catch(() => {})
      sendToRenderer('ipc:events', { type: 'remote-settings-changed', key: 'sessions', workspaceId: projectId })
    },

    notifySettingsChanged(key, sessionFile) {
      sendToRenderer('ipc:events', { type: 'remote-settings-changed', key, ...(sessionFile ? { sessionFile } : {}) })
    },

    storage: {
      get: (key) => configStore.get(key as 'remote'),
      set: (key, value) => configStore.set(key as 'remote', value as never),
    },

    // safeStorage when the OS keyring works. Without one (common on Linux dev boxes) the host key
    // goes to a 0600 file in userData, like an ssh key: an in-memory key would change on every
    // restart and force every phone to scan the QR code again.
    secrets: {
      available: () => true,
      seal: (plain) => {
        if (safeStorageAvailable()) return safeStorage.encryptString(plain).toString('base64')
        const file = join(app.getPath('userData'), HOST_KEY_FILE)
        writeFileSync(file, plain, { mode: 0o600 })
        chmodSync(file, 0o600)
        return HOST_KEY_FILE_MARK
      },
      open: (sealed) => {
        try {
          if (sealed === HOST_KEY_FILE_MARK) return readFileSync(join(app.getPath('userData'), HOST_KEY_FILE), 'utf8').trim() || null
          return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
        } catch {
          return null
        }
      },
    },

    assetPath(name: string): string | null {
      if (name !== 'mermaid.min.js') return null
      try {
        return createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js')
      } catch {
        return null
      }
    },

    log(level, message) {
      if (level === 'error') console.error(message)
      else if (level === 'warn') console.warn(message)
      else console.log(message)
    },
  }
}
