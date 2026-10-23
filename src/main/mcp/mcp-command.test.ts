import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { commandResolves, explainMissingCommands } from './mcp-command'

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mcp-cmd-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('commandResolves', () => {
  it('finds a bare name on PATH', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'srv'), '')
    // Real temp paths: use this platform's PATH separator.
    expect(commandResolves('srv', { PATH: dir, PATHEXT: '.EXE' }, process.platform)).toBe(true)
    expect(commandResolves('other', { PATH: dir, PATHEXT: '.EXE' }, process.platform)).toBe(false)
  })

  it('applies PATHEXT on Windows and reads Path case-insensitively', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'npx.cmd'), '')
    expect(commandResolves('npx', { Path: dir, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(true)
    expect(commandResolves('npx', { Path: dir, PATHEXT: '.EXE' }, 'win32')).toBe(false)
  })

  it('checks a path as given', () => {
    const dir = tempDir()
    const file = join(dir, 'server.js')
    writeFileSync(file, '')
    expect(commandResolves(file, {}, 'linux')).toBe(true)
    expect(commandResolves('/nonexistent-mcp-bin', {}, 'linux')).toBe(false)
    expect(commandResolves('/nonexistent-mcp-bin', { PATHEXT: '.EXE' }, 'win32')).toBe(false)
  })
})

describe('explainMissingCommands', () => {
  const report = {
    errors: [],
    servers: [
      { name: 'broken', scope: 'global', enabled: true, exposure: 'codemode', state: 'failed', tools: [], error: 'MCP connection closed' },
      { name: 'echo', scope: 'global', enabled: true, exposure: 'direct', state: 'connected', tools: ['echo'] },
      { name: 'remote', scope: 'global', enabled: true, exposure: 'codemode', state: 'failed', tools: [], error: '401' },
    ],
  }
  const configs = [
    { name: 'broken', config: { command: '/nonexistent-mcp-bin' } },
    { name: 'echo', config: { command: 'node' } },
    { name: 'remote', config: { url: 'https://example.invalid/mcp' } },
  ]

  it('names the missing command of a failed stdio server', () => {
    const out = explainMissingCommands(report, configs, (cmd) => cmd !== '/nonexistent-mcp-bin')
    expect(out.servers[0].error).toBe('Command not found (ENOENT): /nonexistent-mcp-bin')
  })

  it('leaves connected, remote and resolvable servers alone', () => {
    const out = explainMissingCommands(report, configs, (cmd) => cmd !== '/nonexistent-mcp-bin')
    expect(out.servers[1]).toBe(report.servers[1])
    expect(out.servers[2]).toBe(report.servers[2])
    expect(explainMissingCommands(report, configs, () => true).servers[0]).toBe(report.servers[0])
  })
})
