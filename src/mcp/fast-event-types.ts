export type FastVerificationMode = 'speed' | 'balanced' | 'fortress'
export type FastVerificationDecision = 'pass' | 'reject' | 'escalate'

export interface CompiledEventRule {
  automationId: string
  topic: string
  mode: FastVerificationMode
  sourceHandles: string[]
  minSourceTrust: number
  sourceTiers: Record<string, number>
  actorAliases: string[]
  targetAliases: string[]
  confirmedVerbs: string[]
  rejectPhrases: string[]
  eventType: string
  freshnessMs: number
  quorum: number
  actionReady: boolean
  createdAt: number
}

export interface IncomingEventPost {
  id: string
  sourceHandle: string
  text: string
  createdAt: number
  receivedAt: number
}

export interface FastVerificationEvidence {
  ruleId: string
  sourceHandle: string
  tweetId: string
  actor: string
  target: string
  verb: string
  eventType: string
  matchedText: string
}

export interface FastVerificationResult {
  decision: FastVerificationDecision
  score: number
  reason: string
  matchedRuleIds: string[]
  evidence: FastVerificationEvidence[]
  latencyMs: number
}

export function normalizeFastVerificationMode(value: unknown): FastVerificationMode {
  if (value === 'speed' || value === 'balanced' || value === 'fortress') return value
  return 'balanced'
}

export function normalizeFastSourceHandle(handle: string): string {
  return handle.trim().toLowerCase().replace(/^@/, '')
}
