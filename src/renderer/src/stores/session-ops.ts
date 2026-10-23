/**
 * Pure state transitions on one session's fields, shared by the store's view actions and the
 * per-session facade (`session-scope.ts`) so visible and background sessions behave identically.
 */
import { sanitizeRunStatePatch } from '@renderer/lib/format-run-display'
import type { RunState, TimelineItem } from '@renderer/stores/ui-store-types'

export function insertTimelineItemBefore(
  items: TimelineItem[],
  beforeId: string,
  item: TimelineItem,
): TimelineItem[] {
  const idx = items.findIndex((i) => i.id === beforeId)
  if (idx < 0) return [...items, item]
  const next = [...items]
  next.splice(idx, 0, item)
  return next
}

export function patchTimelineItem(
  items: TimelineItem[],
  id: string,
  patch: Partial<TimelineItem>,
): TimelineItem[] {
  return items.map((i) => (i.id === id ? { ...i, ...patch } : i))
}

/** Drop empty assistant bubbles except the one still streaming; returns `items` when unchanged. */
export function pruneEmptyAssistantItems(
  items: TimelineItem[],
  streamingAssistantId: string | null,
): TimelineItem[] {
  const next = items.filter((i) => {
    if (i.type !== 'assistant-message') return true
    if (i.incomplete) return true
    const hasText = !!(i.text && i.text.trim())
    const hasThink = !!(i.thinkingText && i.thinkingText.trim())
    if (!hasText && !hasThink) return i.id !== streamingAssistantId
    return true
  })
  return next.length === items.length ? items : next
}

/**
 * Apply a run-state patch (empty model / thinking level clears it). Also reports the model and
 * thinking level that were set, so the view can remember them as defaults.
 */
export function applyRunStatePatch(
  runState: RunState,
  patch: Partial<RunState>,
): { runState: RunState; model?: string; thinkingLevel?: string } {
  const clean = sanitizeRunStatePatch(patch as Record<string, unknown>)
  const next = { ...runState } as RunState & Record<string, unknown>
  let model: string | undefined
  let thinkingLevel: string | undefined
  for (const [key, value] of Object.entries(clean)) {
    if (key === 'model') {
      if (value == null || value === '') {
        delete next.model
      } else {
        next.model = value as string
        model = value as string
      }
      continue
    }
    if (key === 'thinkingLevel') {
      if (value == null || value === '') {
        delete next.thinkingLevel
      } else {
        next.thinkingLevel = value as string
        thinkingLevel = value as string
      }
      continue
    }
    next[key] = value
  }
  return { runState: next as RunState, model, thinkingLevel }
}
