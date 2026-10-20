import { describe, expect, it } from 'vitest'
import {
  applyLiveStreamingTextToMergedTimeline,
  mergeLiveCacheTimelineSnapshots,
} from '../streaming-timeline-preserve'
import type { TimelineItem } from '@renderer/stores/ui-store-types'

describe('streaming-timeline-preserve', () => {
  it('mergeLiveCacheTimelineSnapshots keeps longer text across different assistant ids', () => {
    const merged = mergeLiveCacheTimelineSnapshots(
      [
        {
          id: 'opt-user-1',
          type: 'user-message',
          text: 'q',
          sessionEntryId: 'user-entry-1',
          timestamp: 1,
        },
        { id: 'opt-asst-1', type: 'assistant-message', text: 'ab', timestamp: 2 },
      ],
      [
        {
          id: 'cached-u',
          type: 'user-message',
          text: 'q',
          sessionEntryId: 'user-entry-1',
          timestamp: 1,
        },
        { id: 'cached-live-9', type: 'assistant-message', text: 'full streamed body', timestamp: 2 },
      ],
    )
    expect(merged.at(-1)?.text).toBe('full streamed body')
  })

  it('prefers full-page capture over stream-only tail even if assistant text is longer', () => {
    const fullPage: TimelineItem[] = [
      { id: 'h1', type: 'user-message', text: 'older', timestamp: 1 },
      { id: 'h2', type: 'assistant-message', text: 'old answer', timestamp: 2 },
      { id: 'h3', type: 'user-message', text: 'current', timestamp: 3 },
      { id: 'h4', type: 'assistant-message', text: 'partial', timestamp: 4 },
    ]
    const streamOnly: TimelineItem[] = [
      {
        id: 'l1',
        type: 'assistant-message',
        text: 'partial and much longer streamed body',
        runId: 'run-current',
        turnId: 'turn-current',
        timestamp: 5,
      },
    ]
    fullPage[3] = { ...fullPage[3], runId: 'run-current', turnId: 'turn-current' }
    const merged = mergeLiveCacheTimelineSnapshots(streamOnly, fullPage, {
      incomingStreamingAssistantId: 'l1',
    })
    expect(merged.filter((i) => i.type === 'user-message')).toHaveLength(2)
    expect(merged.at(-1)?.text).toBe('partial and much longer streamed body')
  })

  it('applyLiveStreamingTextToMergedTimeline enriches disk-empty assistant from live cache', () => {
    const diskMerged: TimelineItem[] = [
      { id: 'u1', type: 'user-message', text: 'q', turnId: 'turn-1', timestamp: 1 },
      {
        id: 'h4',
        type: 'assistant-message',
        text: '',
        runId: 'run-1',
        turnId: 'turn-1',
        timestamp: 2,
      },
    ]
    const liveItems: TimelineItem[] = [
      {
        id: 'l2',
        type: 'assistant-message',
        text: 'full streamed prefix and more',
        runId: 'run-1',
        turnId: 'turn-1',
        timestamp: 3,
      },
    ]
    const out = applyLiveStreamingTextToMergedTimeline(diskMerged, liveItems, 'l2')
    expect(out.at(-1)?.text).toBe('full streamed prefix and more')
  })

  it('should_not_cross_enrich_last_assistants_when_live_is_a_strict_prefix', () => {
    const merged: TimelineItem[] = [
      { id: 'u1', type: 'user-message', text: 'q1', sessionEntryId: 'u1', timestamp: 1 },
      {
        id: 'a1',
        type: 'assistant-message',
        text: 'completed first answer',
        sessionEntryId: 'a1-entry',
        timestamp: 2,
      },
      { id: 'u2', type: 'user-message', text: 'q2', sessionEntryId: 'u2', timestamp: 3 },
      { id: 'a2', type: 'assistant-message', text: 'new turn partial', timestamp: 4 },
    ]
    const stalePrefix: TimelineItem[] = [
      { id: 'live-u1', type: 'user-message', text: 'q1', sessionEntryId: 'u1', timestamp: 1 },
      {
        id: 'live-a1',
        type: 'assistant-message',
        text: 'completed first answer with a much longer stale body',
        sessionEntryId: 'a1-entry',
        timestamp: 2,
      },
    ]

    const out = applyLiveStreamingTextToMergedTimeline(merged, stalePrefix, 'live-a1')

    expect(out).toEqual(merged)
  })

  it('should_enrich_same_turn_full_page_tail_from_matching_user_entry', () => {
    const merged: TimelineItem[] = [
      { id: 'u1', type: 'user-message', text: 'q1', sessionEntryId: 'u1', timestamp: 1 },
      { id: 'a1', type: 'assistant-message', text: 'a1', sessionEntryId: 'a1', timestamp: 2 },
      { id: 'u2', type: 'user-message', text: 'q2', sessionEntryId: 'u2', timestamp: 3 },
      { id: 'merged-a2', type: 'assistant-message', text: 'partial', timestamp: 4 },
    ]
    const live: TimelineItem[] = [
      { id: 'live-u1', type: 'user-message', text: 'q1', sessionEntryId: 'u1', timestamp: 1 },
      { id: 'live-a1', type: 'assistant-message', text: 'a1', sessionEntryId: 'a1', timestamp: 2 },
      { id: 'live-u2', type: 'user-message', text: 'q2', sessionEntryId: 'u2', timestamp: 3 },
      {
        id: 'live-a2',
        type: 'assistant-message',
        text: 'partial and still streaming',
        timestamp: 5,
      },
    ]

    const out = applyLiveStreamingTextToMergedTimeline(merged, live, 'live-a2')

    expect(out.at(-1)).toMatchObject({
      id: 'merged-a2',
      text: 'partial and still streaming',
    })
    expect(out.at(-1)?.sessionEntryId).toBeUndefined()
  })

  it('should_not_patch_disk_branch_from_rejected_live_suffix', () => {
    const diskMerged: TimelineItem[] = [
      { id: 'u1', type: 'user-message', text: 'q1', sessionEntryId: 'u1', timestamp: 1 },
      {
        id: 'a-new',
        type: 'assistant-message',
        text: 'current branch',
        sessionEntryId: 'a-new',
        timestamp: 2,
      },
    ]
    const staleLive: TimelineItem[] = [
      { id: 'l-u1', type: 'user-message', text: 'q1', sessionEntryId: 'u1', timestamp: 1 },
      {
        id: 'a-old',
        type: 'assistant-message',
        text: 'old branch',
        sessionEntryId: 'a-old',
        timestamp: 2,
      },
    ]

    const out = applyLiveStreamingTextToMergedTimeline(diskMerged, staleLive, 'a-old')

    expect(out).toEqual(diskMerged)
  })

  it('should_not_patch_disk_branch_when_trimmed_live_has_no_common_persisted_identity', () => {
    const diskMerged: TimelineItem[] = [
      { id: 'u1', type: 'user-message', text: 'q1', sessionEntryId: 'u1', timestamp: 1 },
      {
        id: 'a-new',
        type: 'assistant-message',
        text: 'current branch',
        sessionEntryId: 'a-new',
        timestamp: 2,
      },
    ]
    const staleTrimmedLive: TimelineItem[] = [
      { id: 'u2', type: 'user-message', text: 'q2', sessionEntryId: 'u2', timestamp: 3 },
      {
        id: 'a-stale',
        type: 'assistant-message',
        text: 'much longer stale branch answer',
        timestamp: 4,
      },
    ]

    const out = applyLiveStreamingTextToMergedTimeline(
      diskMerged,
      staleTrimmedLive,
      'a-stale',
    )

    expect(out).toEqual(diskMerged)
  })

  it('should_enrich_accepted_trimmed_tail_when_merged_contains_visible_live_identity', () => {
    const merged: TimelineItem[] = [
      { id: 'u1', type: 'user-message', text: 'q1', sessionEntryId: 'u1', timestamp: 1 },
      { id: 'u2', type: 'user-message', text: 'q2', sessionEntryId: 'u2', timestamp: 2 },
      { id: 'a2', type: 'assistant-message', text: 'partial', timestamp: 3 },
    ]
    const live: TimelineItem[] = [
      { id: 'l-u2', type: 'user-message', text: 'q2', sessionEntryId: 'u2', timestamp: 2 },
      {
        id: 'l-a2',
        type: 'assistant-message',
        text: 'partial and still streaming',
        timestamp: 4,
      },
    ]

    const out = applyLiveStreamingTextToMergedTimeline(merged, live, 'l-a2')

    expect(out.at(-1)?.text).toBe('partial and still streaming')
  })

  it('should_not_enrich_current_capture_from_stale_branch_cache', () => {
    const currentCapture: TimelineItem[] = [
      { id: 'u1', type: 'user-message', text: 'q1', sessionEntryId: 'u1', timestamp: 1 },
      {
        id: 'a-new',
        type: 'assistant-message',
        text: 'current branch',
        sessionEntryId: 'a-new',
        timestamp: 2,
      },
    ]
    const staleCache: TimelineItem[] = [
      { id: 'l-u1', type: 'user-message', text: 'q1', sessionEntryId: 'u1', timestamp: 1 },
      {
        id: 'a-old',
        type: 'assistant-message',
        text: 'much longer stale branch answer',
        sessionEntryId: 'a-old',
        timestamp: 2,
      },
    ]

    const merged = mergeLiveCacheTimelineSnapshots(currentCapture, staleCache)

    expect(merged).toEqual(currentCapture)
  })

  it('should_not_enrich_new_turn_from_idle_assistant_only_previous_run', () => {
    const merged: TimelineItem[] = [
      { id: 'u1', type: 'user-message', text: 'q1', sessionEntryId: 'u1', timestamp: 1 },
      { id: 'a1', type: 'assistant-message', text: 'first answer', runId: 'run-1', timestamp: 2 },
      { id: 'u2', type: 'user-message', text: 'q2', sessionEntryId: 'u2', timestamp: 3 },
      { id: 'a2', type: 'assistant-message', text: 'current partial', runId: 'run-2', timestamp: 4 },
    ]
    const staleIdleTail: TimelineItem[] = [
      {
        id: 'stale-a1',
        type: 'assistant-message',
        text: 'first answer with a much longer stale body',
        runId: 'run-1',
        timestamp: 5,
      },
    ]

    const out = applyLiveStreamingTextToMergedTimeline(merged, staleIdleTail, null)

    expect(out).toEqual(merged)
  })

  it('should_enrich_terminal_assistant_only_tail_when_entry_id_matches', () => {
    const merged: TimelineItem[] = [
      { id: 'u1', type: 'user-message', text: 'q', sessionEntryId: 'u1', timestamp: 1 },
      {
        id: 'structural-a1',
        type: 'assistant-message',
        text: 'partial',
        sessionEntryId: 'assistant-entry-1',
        timestamp: 2,
      },
    ]
    const terminalTail: TimelineItem[] = [
      {
        id: 'terminal-a1',
        type: 'assistant-message',
        text: 'complete terminal answer',
        sessionEntryId: 'assistant-entry-1',
        timestamp: 3,
      },
    ]

    const out = applyLiveStreamingTextToMergedTimeline(merged, terminalTail, null)

    expect(out.at(-1)).toMatchObject({
      id: 'structural-a1',
      text: 'complete terminal answer',
      sessionEntryId: 'assistant-entry-1',
    })
  })

  it('should_enrich_terminal_assistant_only_tail_when_turn_id_matches', () => {
    const merged: TimelineItem[] = [
      { id: 'u1', type: 'user-message', text: 'q', turnId: 'turn-1', timestamp: 1 },
      {
        id: 'structural-a1',
        type: 'assistant-message',
        text: 'partial',
        runId: 'run-shared',
        turnId: 'turn-1',
        timestamp: 2,
      },
    ]
    const terminalTail: TimelineItem[] = [
      {
        id: 'terminal-a1',
        type: 'assistant-message',
        text: 'complete terminal answer by turn',
        runId: 'run-shared',
        turnId: 'turn-1',
        timestamp: 3,
      },
    ]

    const out = applyLiveStreamingTextToMergedTimeline(merged, terminalTail, null)

    expect(out.at(-1)).toMatchObject({
      id: 'structural-a1',
      text: 'complete terminal answer by turn',
      turnId: 'turn-1',
    })
  })

  it('should_not_enrich_or_remap_same_run_assistant_from_different_turn', () => {
    const merged: TimelineItem[] = [
      { id: 'u2', type: 'user-message', text: 'q2', turnId: 'turn-2', timestamp: 1 },
      {
        id: 'structural-a2',
        type: 'assistant-message',
        text: 'current partial',
        runId: 'run-shared',
        turnId: 'turn-2',
        timestamp: 2,
      },
    ]
    const staleTail: TimelineItem[] = [
      {
        id: 'stale-a1',
        type: 'assistant-message',
        text: 'stale answer with much longer text',
        runId: 'run-shared',
        turnId: 'turn-1',
        timestamp: 3,
      },
    ]

    expect(applyLiveStreamingTextToMergedTimeline(merged, staleTail, 'stale-a1')).toEqual(
      merged,
    )
  })

  it('should_not_enrich_from_active_assistant_only_different_run', () => {
    const merged: TimelineItem[] = [
      { id: 'u2', type: 'user-message', text: 'q2', sessionEntryId: 'u2', timestamp: 1 },
      { id: 'a2', type: 'assistant-message', text: 'current partial', runId: 'run-2', timestamp: 2 },
    ]
    const activeWrongTurn: TimelineItem[] = [
      {
        id: 'active-a1',
        type: 'assistant-message',
        text: 'much longer text from another active turn',
        runId: 'run-1',
        timestamp: 3,
      },
    ]

    const out = applyLiveStreamingTextToMergedTimeline(merged, activeWrongTurn, 'active-a1')

    expect(out).toEqual(merged)
  })

  it('should_prefer_active_incoming_when_both_cache_snapshots_are_assistant_only', () => {
    const incoming: TimelineItem[] = [
      {
        id: 'active-a2',
        type: 'assistant-message',
        text: 'new',
        runId: 'run-2',
        timestamp: 2,
      },
    ]
    const existing: TimelineItem[] = [
      {
        id: 'idle-a1',
        type: 'assistant-message',
        text: 'old idle answer with a much longer body',
        runId: 'run-1',
        timestamp: 1,
      },
    ]

    const merged = mergeLiveCacheTimelineSnapshots(incoming, existing, {
      incomingStreamingAssistantId: 'active-a2',
      existingStreamingAssistantId: null,
    })

    expect(merged).toEqual(incoming)
  })
})
