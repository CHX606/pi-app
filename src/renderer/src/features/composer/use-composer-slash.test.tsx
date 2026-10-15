import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcClient } from '@renderer/lib/ipc-client'
import { useComposerSlash } from './use-composer-slash'

vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke: vi.fn() } }))
const invoke = vi.mocked(ipcClient.invoke)

beforeEach(() => { invoke.mockReset() })

describe('slash command availability', () => {
  it('opens builtin commands while the catalog is still loading', async () => {
    let resolve!: (result: unknown) => void
    invoke.mockReturnValue(new Promise((done) => { resolve = done }))
    const { result } = renderHook(() => useComposerSlash('/', true, null, '/workspace', vi.fn(), () => []))

    expect(result.current.showPopover).toBe(true)
    expect(result.current.filteredCommands).toContainEqual(expect.objectContaining({ name: '/compact' }))
    expect(invoke).toHaveBeenCalledTimes(1)

    await act(async () => resolve({ source: 'worker', commands: [
      { id: 'custom', name: '/custom', category: 'extension' },
    ] }))

    expect(result.current.filteredCommands).toContainEqual(expect.objectContaining({ name: '/custom' }))
    expect(result.current.filteredCommands).toContainEqual(expect.objectContaining({ name: '/compact' }))
  })

  it('keeps builtin commands when catalog loading fails', async () => {
    invoke.mockRejectedValue(new Error('Worker not ready'))
    const { result } = renderHook(() => useComposerSlash('/compact', true, null, '/workspace', vi.fn(), () => []))

    await waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    expect(result.current.showPopover).toBe(true)
    expect(result.current.filteredCommands.map((command) => command.name)).toEqual(['/compact'])
  })
})
