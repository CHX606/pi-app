import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNodeWorkerTransport } from './worker-transport'

// An echo "worker": answers each stdin line with a framed reply, and logs a stray stdout line first.
const ECHO = `
console.log('stray log line')
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i))
    buf = buf.slice(i + 1)
    if (msg.type === 'exit') process.exit(3)
    process.stdout.write('piw1:' + JSON.stringify({ type: 'echo', requestId: msg.requestId, stdio: process.env.PI_WORKER_STDIO, cwd: process.cwd() }) + '\\n')
  }
})
`

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('createNodeWorkerTransport', () => {
  it('runs the entry under node in stdio mode and decodes framed replies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-node-worker-'))
    dirs.push(dir)
    const entry = join(dir, 'echo.cjs')
    writeFileSync(entry, ECHO)
    const t = createNodeWorkerTransport({ entry, cwd: dir })
    expect(t.kind).toBe('node')
    const stderr: string[] = []
    t.onStderr((c) => stderr.push(c))
    const reply = new Promise<Record<string, unknown>>((resolve) => t.onMessage((m) => resolve(m as Record<string, unknown>)))
    const exited = new Promise<number>((resolve) => t.onExit(resolve))
    t.postMessage({ type: 'ping', requestId: 'r1' })
    const msg = await reply
    expect(msg).toMatchObject({ type: 'echo', requestId: 'r1', stdio: '1' })
    expect(String(msg.cwd).toLowerCase()).toBe(dir.toLowerCase())
    t.postMessage({ type: 'exit' })
    expect(await exited).toBe(3)
    expect(stderr.join('')).toContain('[node-stdout] stray log line')
  })
})
