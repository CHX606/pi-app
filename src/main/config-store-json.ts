import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ConfigBacking } from './config-store'

/**
 * Plain JSON file backing for the config store (headless host, tests). Same top-level semantics as
 * electron-store: stored values sit over a shallow copy of the defaults, and every write rewrites the
 * whole file (atomically, owner-only, since it holds device keys and pairings).
 */
export function createJsonConfigBacking(file: string, defaults: object): ConfigBacking {
  let stored: Record<string, unknown> = {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) stored = raw as Record<string, unknown>
  } catch {
    /* missing or unreadable: start empty */
  }
  const data: Record<string, unknown> = { ...structuredClone(defaults as Record<string, unknown>), ...stored }

  const save = () => {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
  }

  return {
    // electron-store hands out fresh copies too; callers mutate what they get before set().
    get: (key) => (data[key] === undefined ? undefined : structuredClone(data[key])),
    set(key, value) {
      if (value === undefined) delete data[key]
      else data[key] = structuredClone(value)
      save()
    },
    delete(key) {
      delete data[key]
      save()
    },
    get store() {
      return data
    },
  }
}
