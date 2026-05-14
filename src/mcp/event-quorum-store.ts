import { normalizeFastSourceHandle } from './fast-event-types.js'

export interface EventQuorumStoreOptions {
  ttlMs: number
}

export interface EventQuorumRecordInput {
  fingerprint: string
  tweetId: string
  sourceHandle: string
  requiredQuorum: number
  now: number
}

export interface EventQuorumRecordResult {
  met: boolean
  uniqueSources: number
  tweetIds: string[]
}

interface QuorumEntry {
  expiresAt: number
  tweetIds: Set<string>
  sourceHandles: Set<string>
}

export class EventQuorumStore {
  private readonly ttlMs: number
  private readonly entries = new Map<string, QuorumEntry>()

  constructor(options: EventQuorumStoreOptions) {
    this.ttlMs = options.ttlMs
  }

  record(input: EventQuorumRecordInput): EventQuorumRecordResult {
    this.prune(input.now)
    const entry = this.entries.get(input.fingerprint) ?? {
      expiresAt: input.now + this.ttlMs,
      tweetIds: new Set<string>(),
      sourceHandles: new Set<string>(),
    }

    entry.expiresAt = Math.max(entry.expiresAt, input.now + this.ttlMs)
    entry.tweetIds.add(input.tweetId)
    entry.sourceHandles.add(normalizeFastSourceHandle(input.sourceHandle))
    this.entries.set(input.fingerprint, entry)

    return {
      met: entry.sourceHandles.size >= input.requiredQuorum,
      uniqueSources: entry.sourceHandles.size,
      tweetIds: [...entry.tweetIds],
    }
  }

  private prune(now: number): void {
    for (const [fingerprint, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(fingerprint)
    }
  }
}
