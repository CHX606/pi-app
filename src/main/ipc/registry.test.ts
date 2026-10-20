import { describe, expect, it, vi } from 'vitest'
import { bindIpcMain, invokeHandler, registerHandler } from './registry'

describe('ipc registry', () => {
  it('serves handlers in-process without ipcMain and exposes them once bound', async () => {
    registerHandler('ipc:test.early', async (req) => ({ echo: req.x }))
    expect(await invokeHandler('ipc:test.early', { x: 1 })).toEqual({ echo: 1 })

    const listeners = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>()
    const ipc = {
      handle: vi.fn((channel: string, fn: (event: unknown, request: unknown) => Promise<unknown>) => void listeners.set(channel, fn)),
      removeHandler: vi.fn((channel: string) => void listeners.delete(channel)),
    }
    bindIpcMain(ipc)
    expect(await listeners.get('ipc:test.early')?.({}, { x: 2 })).toEqual({ echo: 2 })

    registerHandler('ipc:test.late', async () => 'late')
    expect(await listeners.get('ipc:test.late')?.({}, {})).toBe('late')

    // Re-registering replaces the handler behind the same channel.
    registerHandler('ipc:test.late', async () => 'again')
    expect(await listeners.get('ipc:test.late')?.({}, {})).toBe('again')
    expect(await invokeHandler('ipc:test.late')).toBe('again')
  })
})
