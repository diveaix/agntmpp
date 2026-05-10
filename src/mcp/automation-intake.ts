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
  { id: 'mode', question: 'Should I notify, ask first, or auto-execute?', reason: 'Controls whether the automation can trade without another approval.' },
  { id: 'maxSpend', question: 'What is the maximum amount this automation can spend?', reason: 'Caps financial risk per trigger.' },
]

const POLYMARKET_QUESTIONS: IntakeQuestion[] = [
  { id: 'marketId', question: 'Which Polymarket market should this trade?', reason: 'Sub-10s execution requires the market to be selected before the event.' },
  { id: 'side', question: 'Should it buy YES or NO?', reason: 'The executor needs the exact outcome before activation.' },
  { id: 'maxPrice', question: 'What is the highest outcome price you are willing to pay?', reason: 'Prevents buying after the market reprices too far.' },
]

const HYPERLIQUID_TRADE_QUESTIONS: IntakeQuestion[] = [
  { id: 'market', question: 'Which Hyperliquid market should this trade?', reason: 'The perp market must be preselected for fast execution.' },
  { id: 'side', question: 'Should it long or short?', reason: 'The executor needs exact direction before activation.' },
  { id: 'amountUsd', question: 'How much USDC should it use?', reason: 'Caps position size.' },
  { id: 'leverage', question: 'What leverage should it use?', reason: 'Needed for liquidation and margin checks.' },
  { id: 'stopLossPercent', question: 'What stop loss percent should protect the trade?', reason: 'Hyperliquid auto-execute trades require downside protection.' },
]

const HL_MONITOR_QUESTIONS: IntakeQuestion[] = [
  { id: 'metric', question: 'Which Hyperliquid metric should I watch?', reason: 'Needed to decide which information feed to evaluate.' },
  { id: 'condition', question: 'What condition should trigger the monitor?', reason: 'Needed to evaluate the metric.' },
  { id: 'validFor', question: 'How long should this monitor stay active?', reason: 'Prevents stale monitors from running forever.' },
  { id: 'mode', question: 'Should I notify only or ask before action?', reason: 'Controls how monitor results are handled.' },
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
  const protocol = args.protocol
  const questions = [...BASE_EVENT_QUESTIONS]
  if (protocol === 'polymarket') questions.push(...POLYMARKET_QUESTIONS)
  if (protocol === 'hyperliquid') questions.push(...HYPERLIQUID_TRADE_QUESTIONS)
  const missing = missingFrom(args, questions)
  return { ok: missing.length === 0, missing }
}

export function checkHyperliquidMonitorIntake(args: Record<string, unknown>): IntakeCheckResult {
  const missing = missingFrom(args, HL_MONITOR_QUESTIONS)
  return { ok: missing.length === 0, missing }
}

export function formatMissingQuestions(result: IntakeCheckResult): string {
  if (result.ok) return ''
  const lines = ['Before activating this automation, ask the user:']
  for (const q of result.missing) lines.push(`- ${q.question} (${q.reason})`)
  return lines.join('\n')
}
