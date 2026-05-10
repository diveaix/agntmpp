import type { AutomationEntry } from './scheduler.js'
import { isAutomationStillValid, type EventTriggerAutomationParams, type TopicRule, type TweetSourceMeta } from './automation-types.js'
import { buildTopicRule } from './automation-tags.js'
import { listCustomSources } from './access-store.js'

const TOPIC_SOURCES: Record<string, TweetSourceMeta[]> = {
  iran_israel_conflict: [
    { handle: 'Reuters', enabled: true, topics: ['iran_israel_conflict'], trustScore: 0.95 },
    { handle: 'sentdefender', enabled: true, topics: ['iran_israel_conflict'], trustScore: 0.72 },
    { handle: 'IranIntl_En', enabled: true, topics: ['iran_israel_conflict'], trustScore: 0.78 },
  ],
  middle_east_conflict: [
    { handle: 'Reuters', enabled: true, topics: ['middle_east_conflict'], trustScore: 0.95 },
    { handle: 'AP', enabled: true, topics: ['middle_east_conflict'], trustScore: 0.94 },
  ],
  crypto_security: [
    { handle: 'peckshield', enabled: true, topics: ['crypto_security'], trustScore: 0.88 },
    { handle: 'zachxbt', enabled: true, topics: ['crypto_security'], trustScore: 0.86 },
  ],
}

export interface SourceState {
  topicRules: TopicRule[]
  sources: TweetSourceMeta[]
}

function eventTopic(auto: AutomationEntry): string | null {
  if (auto.status !== 'active') return null
  if (auto.type !== 'event_trigger') return null
  const params = auto.params as unknown as EventTriggerAutomationParams
  if (!isAutomationStillValid(params.validUntil)) return null
  return params.trigger?.topic || null
}

export function deriveSourceState(automations: AutomationEntry[], customStorePath?: string): SourceState {
  const topicCounts = new Map<string, number>()
  const activeUserTopics = new Map<string, Set<string>>()
  for (const auto of automations) {
    const topic = eventTopic(auto)
    if (!topic) continue
    topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1)
    if (auto.userId) {
      const topics = activeUserTopics.get(auto.userId) || new Set<string>()
      topics.add(topic)
      activeUserTopics.set(auto.userId, topics)
    }
  }

  const topicRules: TopicRule[] = []
  const sourceByHandle = new Map<string, TweetSourceMeta>()

  for (const [topic, count] of topicCounts) {
    const sources = TOPIC_SOURCES[topic] || []
    const customSources = listCustomSources(undefined, customStorePath)
      .filter((source) => source.enabled && source.topics.includes(topic))
      .filter((source) => {
        const topics = activeUserTopics.get(source.userId)
        return Boolean(topics?.has(topic))
      })
      .map((source) => ({
        handle: source.handle,
        enabled: source.enabled,
        topics: source.topics,
        trustScore: source.trustScore,
      }))
    const allSources = [...sources, ...customSources]
    topicRules.push(buildTopicRule(topic, count, allSources.map((s) => s.handle)))
    for (const source of allSources) {
      const key = source.handle.toLowerCase()
      const existing = sourceByHandle.get(key)
      if (existing) {
        existing.topics = [...new Set([...existing.topics, ...source.topics])]
        existing.trustScore = Math.max(existing.trustScore, source.trustScore)
      } else {
        sourceByHandle.set(key, { ...source })
      }
    }
  }

  return { topicRules, sources: [...sourceByHandle.values()] }
}
