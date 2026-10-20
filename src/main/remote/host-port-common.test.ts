import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const wm = vi.hoisted(() => ({
  hasLiveSessionWorker: vi.fn(() => false),
  loadSession: vi.fn(async () => {}),
  setCapabilities: vi.fn(async () => {}),
  sendPrompt: vi.fn(async () => {}),
  steer: vi.fn(async () => {}),
  followUp: vi.fn(async () => {}),
  clearPromptQueue: vi.fn(async () => ({ steering: ['s'], followUp: ['f'] })),
  newSessionInBackground: vi.fn(async () => ({ sessionFile: '/w/.pi/new.jsonl' })),
  getState: vi.fn(async () => ({ isStreaming: true, model: 'anthropic/sonnet', thinkingLevel: 'high' })),
  setThinkingLevel: vi.fn(async () => {}),
}))
vi.mock('../worker-manager', () => ({ workerManager: wm }))

import { CONFIG_DEFAULTS, installConfigBacking } from '../config-store'
import { createJsonConfigBacking } from '../config-store-json'
import { THINKING_LEVELS, projectFileOps, toContextStats, toHostModelList, workerSessionOps } from './host-port-common'

const dir = mkdtempSync(join(tmpdir(), 'pi-host-common-'))
installConfigBacking(createJsonConfigBacking(join(dir, 'config.json'), CONFIG_DEFAULTS))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  for (const fn of Object.values(wm)) fn.mockClear()
})

describe('toHostModelList', () => {
  it('drops unavailable models, qualifies ids and orders custom, key, sign-in', () => {
    const list = toHostModelList(
      [
        { id: 'o', provider: 'openai-codex', auth: { type: 'oauth' } },
        { id: 'k', provider: 'anthropic', auth: { source: 'auth_json' } },
        { id: 'gone', provider: 'x', available: false },
        { id: 'c', provider: 'local', name: 'Local', auth: { source: 'models_json_key' } },
      ],
      { running: false },
    )
    expect(list.models).toEqual([
      { id: 'local/c', name: 'Local', provider: 'local', group: 'custom' },
      { id: 'anthropic/k', provider: 'anthropic', group: 'apiKey' },
      { id: 'openai-codex/o', provider: 'openai-codex', group: 'login' },
    ])
    expect(list.availableThinking).toEqual([...THINKING_LEVELS])
  })
})

describe('toContextStats', () => {
  it('converts chars to tokens and finds the window of the current model', () => {
    const stats = toContextStats({ messageCount: 3, estimatedChars: 4000, roleBreakdown: [{ role: 'user', chars: 400 }] }, 'anthropic/sonnet', [
      { id: 'sonnet', provider: 'anthropic', contextWindow: 200_000 },
    ])
    expect(stats).toEqual({ tokens: 1000, window: 200_000, messages: 3, breakdown: [{ role: 'user', tokens: 100 }] })
  })
})

describe('workerSessionOps', () => {
  it('binds a cold session to its own worker before sending, with its capabilities', async () => {
    const invalidateSessions = vi.fn()
    const ops = workerSessionOps({ invalidateSessions })
    await ops.send('/w/.pi/s.jsonl', 'hi', 'steer', [], '/w')
    expect(wm.loadSession).toHaveBeenCalledWith('/w/.pi/s.jsonl', { cwd: '/w' })
    expect(wm.setCapabilities).toHaveBeenCalled()
    expect(wm.steer).toHaveBeenCalledWith('hi', '/w/.pi/s.jsonl')
    expect(wm.sendPrompt).not.toHaveBeenCalled()
  })

  it('never spawns a worker to read an empty queue', async () => {
    const ops = workerSessionOps({ invalidateSessions: vi.fn() })
    expect(await ops.clearQueue('/w/s.jsonl')).toEqual([])
    wm.hasLiveSessionWorker.mockReturnValueOnce(true)
    expect(await ops.clearQueue('/w/s.jsonl')).toEqual(['s', 'f'])
  })

  it('creates background sessions and refreshes the project list', async () => {
    const invalidateSessions = vi.fn()
    const ops = workerSessionOps({ invalidateSessions })
    expect(await ops.createSession('/w')).toBe('/w/.pi/new.jsonl')
    expect(invalidateSessions).toHaveBeenCalledWith('/w')
  })

  it('reports the live worker state', async () => {
    const ops = workerSessionOps({ invalidateSessions: vi.fn() })
    expect(await ops.liveState('/w/s.jsonl')).toEqual({ running: true, model: 'anthropic/sonnet', thinking: 'high' })
  })
})

describe('projectFileOps capabilities', () => {
  it('remembers capabilities per session file', () => {
    projectFileOps.setSessionCapabilities('/w/s.jsonl', ['browser'])
    expect(projectFileOps.sessionCapabilities('/w/s.jsonl')).toEqual(['browser'])
    projectFileOps.setSessionCapabilities('/w/s.jsonl', [])
    expect(projectFileOps.sessionCapabilities('/w/s.jsonl')).toEqual([])
  })
})
