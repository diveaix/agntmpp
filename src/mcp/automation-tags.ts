import type { IncomingTweet, PrefilterMatch, TopicRule, TweetSourceMeta } from './automation-types.js'

const TOPIC_KEYWORDS: Record<string, string[]> = {
  iran_israel_conflict: ['iran', 'israel', 'missile', 'missiles', 'strike', 'attack', 'irgc', 'idf', 'launches', 'launched'],
  middle_east_conflict: ['iran', 'israel', 'gaza', 'lebanon', 'hezbollah', 'missile', 'strike', 'attack'],
  crypto_security: ['hack', 'exploit', 'drain', 'bridge', 'vulnerability', 'stolen'],
  crypto_market: ['bitcoin', 'btc', 'ethereum', 'eth', 'etf', 'liquidation', 'funding'],
}

const TOPIC_ENTITIES: Record<string, string[]> = {
  iran_israel_conflict: ['Iran', 'Israel', 'IRGC', 'IDF'],
  middle_east_conflict: ['Iran', 'Israel', 'Gaza', 'Lebanon', 'Hezbollah'],
  crypto_security: ['DeFi', 'bridge', 'protocol', 'wallet'],
  crypto_market: ['BTC', 'ETH', 'Bitcoin', 'Ethereum'],
}

function includesTerm(text: string, term: string): boolean {
  return text.toLowerCase().includes(term.toLowerCase())
}

function matchesAny(text: string, terms: string[]): string[] {
  return terms.filter((term) => includesTerm(text, term))
}

export function buildTopicRule(topic: string, activeAutomationCount: number, sourceHandles: string[] = []): TopicRule {
  return {
    topic,
    activeAutomationCount,
    keywords: TOPIC_KEYWORDS[topic] || [topic.replace(/_/g, ' ')],
    entities: TOPIC_ENTITIES[topic] || [],
    sourceHandles,
  }
}

export function prefilterTweet(tweet: IncomingTweet, sources: TweetSourceMeta[], topicRules: TopicRule[]): PrefilterMatch {
  const source = sources.find((s) => s.handle.toLowerCase() === tweet.authorHandle.toLowerCase())
  if (!source?.enabled) {
    return { shouldVerify: false, candidateTopics: [], matchedKeywords: [], matchedEntities: [], sourceTrust: 0 }
  }

  const candidateTopics: string[] = []
  const matchedKeywords = new Set<string>()
  const matchedEntities = new Set<string>()

  for (const rule of topicRules) {
    if (rule.activeAutomationCount <= 0) continue
    if (!source.topics.includes(rule.topic)) continue
    if (rule.sourceHandles.length && !rule.sourceHandles.some((h) => h.toLowerCase() === tweet.authorHandle.toLowerCase())) continue

    const keywordMatches = matchesAny(tweet.text, rule.keywords)
    const entityMatches = matchesAny(tweet.text, rule.entities)
    if (keywordMatches.length || entityMatches.length) {
      candidateTopics.push(rule.topic)
      keywordMatches.forEach((m) => matchedKeywords.add(m))
      entityMatches.forEach((m) => matchedEntities.add(m))
    }
  }

  return {
    shouldVerify: candidateTopics.length > 0,
    candidateTopics,
    matchedKeywords: [...matchedKeywords],
    matchedEntities: [...matchedEntities],
    sourceTrust: source.trustScore,
  }
}
