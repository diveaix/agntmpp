import {
  normalizeFastSourceHandle,
  normalizeFastVerificationMode,
  type CompiledEventRule,
  type FastVerificationMode,
} from './fast-event-types.js'
import type { UniversalEventTrigger } from './automation-types.js'

export interface CompileEventAutomationInput {
  automationId: string
  topic: string
  triggerText?: string
  trigger?: UniversalEventTrigger
  sourceHandles: string[]
  sourceTiers: Record<string, number>
  verificationMode?: FastVerificationMode | string
  actionReady: boolean
  createdAt: number
}

const knownEntities = [
  'iran',
  'israel',
  'greenland',
  'trump',
  'china',
  'taiwan',
  'russia',
  'ukraine',
  'bitcoin',
  'ethereum',
  'eth',
  'btc',
]

const defaultConfirmedVerbs = [
  'attack',
  'attacks',
  'attacked',
  'strike',
  'strikes',
  'struck',
  'launch',
  'launches',
  'launched',
  'fire',
  'fires',
  'fired',
  'bomb',
  'bombed',
  'hit',
  'hits',
  'invade',
  'invades',
  'invaded',
]

const defaultRejectPhrases = [
  'may attack',
  'might attack',
  'could attack',
  'would attack',
  'plans to attack',
  'planning to attack',
  'threatens to attack',
  'expected to attack',
  'rumor',
  'rumour',
  'unconfirmed',
  'fake',
  'denies',
  'not attacked',
  'no attack',
]

function aliasesFrom(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return []
  return [value.trim().toLowerCase()]
}

function extractEntityPair(triggerText: string): { actorAliases: string[]; targetAliases: string[] } {
  const lower = triggerText.toLowerCase()
  const hits = knownEntities.filter((entity) => new RegExp(`\\b${entity}\\b`, 'i').test(lower))
  const actor = hits[0] ?? ''
  const target = hits.find((entity) => entity !== actor) ?? ''
  return {
    actorAliases: actor ? [actor] : [],
    targetAliases: target ? [target] : [],
  }
}

function sourceTierMap(sourceTiers: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(sourceTiers).map(([handle, trust]) => [normalizeFastSourceHandle(handle), trust]),
  )
}

function defaultQuorum(mode: FastVerificationMode): number {
  return mode === 'fortress' ? 2 : 1
}

function minTrust(mode: FastVerificationMode): number {
  if (mode === 'speed') return 0.9
  if (mode === 'fortress') return 0.85
  return 0.8
}

export function compileEventAutomation(input: CompileEventAutomationInput): CompiledEventRule {
  const mode = normalizeFastVerificationMode(input.verificationMode)
  const fromTrigger = {
    actorAliases: aliasesFrom(input.trigger?.actor),
    targetAliases: aliasesFrom(input.trigger?.target),
  }
  const fromText = extractEntityPair(input.triggerText || '')
  const actorAliases = fromTrigger.actorAliases.length ? fromTrigger.actorAliases : fromText.actorAliases
  const targetAliases = fromTrigger.targetAliases.length ? fromTrigger.targetAliases : fromText.targetAliases

  return {
    automationId: input.automationId,
    topic: input.topic,
    mode,
    sourceHandles: input.sourceHandles.map(normalizeFastSourceHandle),
    minSourceTrust: minTrust(mode),
    sourceTiers: sourceTierMap(input.sourceTiers),
    actorAliases,
    targetAliases,
    confirmedVerbs: defaultConfirmedVerbs,
    rejectPhrases: defaultRejectPhrases,
    eventType: input.trigger?.eventType || 'military_attack',
    freshnessMs: Number(process.env.AGNT_FAST_VERIFY_MAX_TWEET_AGE_MS || 120_000),
    quorum: defaultQuorum(mode),
    actionReady: input.actionReady,
    createdAt: input.createdAt,
  }
}
