// A stdio MCP server whose command does not exist fails differently per platform: Node reports
// ENOENT, but on Windows cross-spawn runs unresolved commands through cmd.exe, which just exits —
// pi then reports only "connection closed". Resolve the command the same way so the settings page
// can say what is actually wrong on every platform.

import { statSync } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
import type { McpServerConfig } from './mcp-config'
import type { McpStatusReport } from './mcp-cli'

type Env = Record<string, string | undefined>

function envVar(env: Env, name: string): string | undefined {
  // Windows environment names are case-insensitive (Path vs PATH).
  const key = Object.keys(env).find((k) => k.toUpperCase() === name)
  return key ? env[key] : undefined
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Whether `command` resolves to an executable file: a path as given, or a name found on PATH. */
export function commandResolves(command: string, env: Env = process.env, platform = process.platform): boolean {
  const cmd = command.trim()
  if (!cmd) return false
  const win = platform === 'win32'
  const exts = win
    ? ['', ...(envVar(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : ['']
  const withExts = (base: string): string[] =>
    win && extname(base) && exts.some((e) => e && e.toLowerCase() === extname(base).toLowerCase())
      ? [base]
      : exts.flatMap((e) => (e ? [...new Set([e, e.toLowerCase(), e.toUpperCase()])] : [e]).map((x) => base + x))

  if (/[\\/]/.test(cmd)) {
    // A relative path depends on the server's own cwd; only judge absolute ones.
    if (!isAbsolute(cmd) && !(win && /^[\\/]/.test(cmd))) return true
    return withExts(cmd).some(isFile)
  }
  const dirs = (envVar(env, 'PATH') ?? '').split(win ? ';' : ':').filter(Boolean)
  return dirs.some((dir) => withExts(join(dir, cmd)).some(isFile))
}

/** Replace a vague failure of a stdio server whose command cannot be found with the real cause. */
export function explainMissingCommands(
  report: McpStatusReport,
  configs: ReadonlyArray<{ name: string; config: McpServerConfig }>,
  resolves: (command: string) => boolean = (command) => commandResolves(command),
): McpStatusReport {
  const byName = new Map(configs.map((row) => [row.name, row.config]))
  return {
    ...report,
    servers: report.servers.map((server) => {
      if (server.state !== 'failed') return server
      const command = byName.get(server.name)?.command
      if (typeof command !== 'string' || resolves(command)) return server
      return { ...server, error: `Command not found (ENOENT): ${command}` }
    }),
  }
}
