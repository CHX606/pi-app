const STORE_KEY = 'codexAccessTokenEnc'

let backing: { get: (k: string) => unknown; set: (k: string, v: unknown) => void; delete?: (k: string) => void } | null =
  null

/** OS-backed string encryption (Electron safeStorage on the desktop). Absent on the headless host. */
export type SecretCipher = {
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(sealed: Buffer): string
  /** Tell the user a secret was not persisted. */
  warnUnavailable?(message: string): void
}

let cipher: SecretCipher | null = null

export function installSecretCipher(next: SecretCipher | null): void {
  cipher = next
}

export function bindSecretStoreBacking(store: {
  get: (k: string) => unknown
  set: (k: string, v: unknown) => void
  delete?: (k: string) => void
}): void {
  backing = store
}

export function isCodexTokenEncryptionAvailable(): boolean {
  try {
    return !!cipher?.available()
  } catch (e) {
    return false
  }
}

export function setCodexAccessToken(token: string | null | undefined): void {
  if (!backing) return
  const t = token?.trim()
  if (!t || t.length < 20) {
    if (backing.delete) backing.delete(STORE_KEY)
    else backing.set(STORE_KEY, undefined)
    return
  }
  if (!cipher || !isCodexTokenEncryptionAvailable()) {
    console.warn('[secret-store] safeStorage unavailable; codex token not persisted')
    cipher?.warnUnavailable?.('系统加密不可用，Codex Token 未持久化。重启后需重新输入。')
    return
  }
  const enc = cipher.encrypt(t)
  backing.set(STORE_KEY, enc.toString('base64'))
}

export function getCodexAccessToken(): string | null {
  if (!backing) return null
  const raw = backing.get(STORE_KEY)
  if (raw == null || raw === '') return null
  if (!cipher || !isCodexTokenEncryptionAvailable()) return null
  try {
    const buf = Buffer.from(String(raw), 'base64')
    const plain = cipher.decrypt(buf)
    return plain && plain.length >= 20 ? plain : null
  } catch (e) {
    return null
  }
}
