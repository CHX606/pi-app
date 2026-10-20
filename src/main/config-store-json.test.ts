import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createJsonConfigBacking } from './config-store-json'
import { CONFIG_DEFAULTS, configStore, installConfigBacking } from './config-store'

const dirs: string[] = []
const tempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-config-json-'))
  dirs.push(dir)
  return join(dir, 'nested', 'config.json')
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('createJsonConfigBacking', () => {
  it('serves defaults until a value is stored, then persists it', () => {
    const file = tempFile()
    const a = createJsonConfigBacking(file, { maxSessionWorkers: 4, recentProjects: [] })
    expect(a.get('maxSessionWorkers')).toBe(4)
    a.set('maxSessionWorkers', 2)
    expect(JSON.parse(readFileSync(file, 'utf8')).maxSessionWorkers).toBe(2)
    const b = createJsonConfigBacking(file, { maxSessionWorkers: 4, recentProjects: [] })
    expect(b.get('maxSessionWorkers')).toBe(2)
    expect(b.get('recentProjects')).toEqual([])
  })

  it('hands out copies, like electron-store', () => {
    const backing = createJsonConfigBacking(tempFile(), { skillOverrides: {} })
    const got = backing.get('skillOverrides') as Record<string, boolean>
    got.x = false
    expect(backing.get('skillOverrides')).toEqual({})
  })

  it('backs configStore once installed', () => {
    installConfigBacking(createJsonConfigBacking(tempFile(), CONFIG_DEFAULTS))
    configStore.setSkillOverride('k', false)
    expect(configStore.getSkillOverrides()).toEqual({ k: false })
    expect(configStore.get('maxSessionWorkers')).toBe(CONFIG_DEFAULTS.maxSessionWorkers)
  })
})
