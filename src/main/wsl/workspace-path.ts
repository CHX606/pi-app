import { wslPathToWindows } from '@shared/wsl-path'
import { getAgentRuntimeConfig } from './runtime-config'

/** Keep main-process workspace paths accessible to the host filesystem. */
export function normalizeWorkspaceCwd(value: string): string {
  const cwd = value.trim()
  if (!/^\/(?!\/)/.test(cwd)) return cwd
  const { mode, distro } = getAgentRuntimeConfig()
  return mode === 'wsl' && distro ? wslPathToWindows(distro, cwd) : cwd
}
