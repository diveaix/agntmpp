export interface IntakeQuestion {
  id: string
  question: string
  reason: string
}

export interface IntakeCheckResult {
  ok: boolean
  missing: IntakeQuestion[]
}

const BASE_EVENT_QUESTIONS: IntakeQuestion[] = [
  { id: 'topic', question: 'What event should I watch?', reason: 'Needed to enable the right Twitter source rules.' },
  { id: 'eventType', question: 'What exactly counts as a trigger?', reason: 'Needed so Grok can confirm the tweet against the automation.' },
  { id: 'validFor', question: 'How long should this automation stay active?', reason: 'Prevents stale automations from firing days or months later.' },
]

function hasValue(args: Record<string, unknown>, id: string): boolean {
  const value = args[id]
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number') return Number.isFinite(value) && value > 0
  return true
}

function missingFrom(args: Record<string, unknown>, questions: IntakeQuestion[]): IntakeQuestion[] {
  return questions.filter((q) => !hasValue(args, q.id))
}

export function checkEventAutomationIntake(args: Record<string, unknown>): IntakeCheckResult {
  const missing = missingFrom(args, BASE_EVENT_QUESTIONS)
  return { ok: missing.length === 0, missing }
}

export function formatMissingQuestions(result: IntakeCheckResult): string {
  if (result.ok) return ''
  const lines = ['Before activating this automation, ask the user:']
  for (const q of result.missing) lines.push(`- ${q.question} (${q.reason})`)
  return lines.join('\n')
}
