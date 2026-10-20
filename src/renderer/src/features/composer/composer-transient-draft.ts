import { viewSessionKeyOf, type ViewKeyInput } from '@renderer/stores/session-state'
import type { Segment } from './attachments'

export type ComposerDraftContext = ViewKeyInput

/** Unsent composer text per session; keyed exactly like `sessionStates` (session file or draft). */
const transientDrafts = new Map<string, Segment[]>()

export function composerDraftContextKey(context: ComposerDraftContext): string {
  return viewSessionKeyOf(context)
}

export function rememberTransientComposerDraft(contextKey: string, segments: Segment[]): void {
  if (segments.length === 0) {
    clearTransientComposerDraft(contextKey)
    return
  }
  transientDrafts.set(contextKey, segments)
}

export function readTransientComposerDraft(contextKey: string): Segment[] | null {
  return transientDrafts.get(contextKey) ?? null
}

export function clearTransientComposerDraft(contextKey: string): void {
  transientDrafts.delete(contextKey)
}
