import type { IncomingTweet, TweetSourceMeta } from './automation-types.js'

export interface TwitterApiIoClientConfig {
  apiKey?: string
  baseUrl?: string
  pollIntervalMs?: number
  tweetsPerSource?: number
  fetchImpl?: typeof fetch
}

export interface TwitterPollStats {
  sourceCount: number
  tweetCount: number
  startedAt: number
  finishedAt: number
  latencyMs: number
}

export interface TwitterPollingHandle {
  stop: () => void
  pollNow: () => Promise<TwitterPollStats>
}

type ProviderTweet = Record<string, unknown>

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeHandle(value: string): string {
  return value.trim().replace(/^@/, '')
}

function tweetArrayFromResponse(json: unknown): ProviderTweet[] {
  if (Array.isArray(json)) return json as ProviderTweet[]
  const obj = json as Record<string, unknown>
  for (const key of ['tweets', 'data', 'items', 'results']) {
    const value = obj?.[key]
    if (Array.isArray(value)) return value as ProviderTweet[]
  }
  const nested = obj?.data as Record<string, unknown> | undefined
  if (nested) {
    for (const key of ['tweets', 'items', 'results']) {
      const value = nested[key]
      if (Array.isArray(value)) return value as ProviderTweet[]
    }
  }
  return []
}

export function normalizeProviderTweet(tweet: ProviderTweet, fallbackHandle: string): IncomingTweet | null {
  const id = asString(tweet.id) || asString(tweet.tweetId) || asString(tweet.rest_id) || asString(tweet.url)
  const text = asString(tweet.text) || asString(tweet.fullText) || asString(tweet.full_text) || asString(tweet.content)
  const createdAt =
    asString(tweet.createdAt) ||
    asString(tweet.created_at) ||
    asString(tweet.timestamp) ||
    (asNumber(tweet.createdAtEpoch) ? new Date(asNumber(tweet.createdAtEpoch)! * 1000).toISOString() : undefined) ||
    new Date().toISOString()
  const authorObj = tweet.author as Record<string, unknown> | undefined
  const authorHandle =
    asString(tweet.authorHandle) ||
    asString(tweet.userName) ||
    asString(tweet.username) ||
    asString(authorObj?.userName) ||
    asString(authorObj?.username) ||
    fallbackHandle
  if (!id || !text) return null
  return {
    id,
    text,
    authorHandle: normalizeHandle(authorHandle),
    createdAt,
    url: asString(tweet.url) || `https://x.com/${normalizeHandle(authorHandle)}/status/${id}`,
  }
}

export class TwitterApiIoClient {
  private readonly seenTweetIds = new Set<string>()
  private currentSources: TweetSourceMeta[] = []

  constructor(private readonly config: TwitterApiIoClientConfig) {}

  isEnabled(): boolean {
    return Boolean(this.config.apiKey)
  }

  async updateSources(sources: TweetSourceMeta[]): Promise<void> {
    if (!this.isEnabled()) return
    this.currentSources = sources
      .filter((source) => source.enabled)
      .map((source) => ({ ...source, handle: normalizeHandle(source.handle) }))
  }

  onTweet(_handler: (tweet: IncomingTweet) => Promise<void> | void): void {
    if (!this.isEnabled()) return
  }

  async fetchRecentTweets(source: TweetSourceMeta): Promise<IncomingTweet[]> {
    if (!this.isEnabled()) return []
    const handle = normalizeHandle(source.handle)
    const url = new URL(`${this.runtimeBaseUrl()}/twitter/user/last_tweets`)
    url.searchParams.set('userName', handle)
    url.searchParams.set('limit', String(this.runtimeTweetsPerSource()))

    const res = await this.runtimeFetch()(url, {
      method: 'GET',
      headers: {
        'X-API-Key': this.config.apiKey || '',
        'x-api-key': this.config.apiKey || '',
        'Accept': 'application/json',
      },
    })
    if (!res.ok) throw new Error(`TwitterAPI.io ${res.status}: ${await res.text().catch(() => '')}`)
    const json = await res.json()
    return tweetArrayFromResponse(json)
      .map((tweet) => normalizeProviderTweet(tweet, handle))
      .filter((tweet): tweet is IncomingTweet => Boolean(tweet))
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }

  async pollOnce(handler: (tweet: IncomingTweet) => Promise<void> | void, sources = this.currentSources): Promise<TwitterPollStats> {
    const startedAt = Date.now()
    if (!this.isEnabled() || sources.length === 0) {
      return { sourceCount: sources.length, tweetCount: 0, startedAt, finishedAt: Date.now(), latencyMs: Date.now() - startedAt }
    }
    let tweetCount = 0
    await Promise.all(sources.map(async (source) => {
      try {
        const tweets = await this.fetchRecentTweets(source)
        for (const tweet of tweets) {
          if (this.seenTweetIds.has(tweet.id)) continue
          this.seenTweetIds.add(tweet.id)
          tweetCount += 1
          await handler(tweet)
        }
      } catch (e) {
        console.warn(`[TwitterAPI.io] ${source.handle}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }))
    const finishedAt = Date.now()
    return { sourceCount: sources.length, tweetCount, startedAt, finishedAt, latencyMs: finishedAt - startedAt }
  }

  startPolling(input: {
    getSources: () => TweetSourceMeta[]
    onTweet: (tweet: IncomingTweet) => Promise<void> | void
    onPoll?: (stats: TwitterPollStats) => void
  }): TwitterPollingHandle {
    let stopped = false
    let timer: NodeJS.Timeout | null = null
    let inFlight = false

    const poll = async () => {
      if (stopped || inFlight) return { sourceCount: 0, tweetCount: 0, startedAt: Date.now(), finishedAt: Date.now(), latencyMs: 0 }
      inFlight = true
      try {
        const sources = input.getSources().filter((source) => source.enabled)
        await this.updateSources(sources)
        const stats = await this.pollOnce(input.onTweet, sources)
        input.onPoll?.(stats)
        return stats
      } finally {
        inFlight = false
      }
    }

    const schedule = () => {
      if (stopped) return
      timer = setTimeout(async () => {
        await poll()
        schedule()
      }, this.runtimePollIntervalMs())
      timer.unref()
    }

    void poll()
    schedule()

    return {
      stop: () => {
        stopped = true
        if (timer) clearTimeout(timer)
      },
      pollNow: poll,
    }
  }

  private runtimeBaseUrl(): string {
    return (this.config.baseUrl || process.env.TWITTERAPI_IO_BASE_URL || 'https://api.twitterapi.io').replace(/\/$/, '')
  }

  private runtimePollIntervalMs(): number {
    return this.config.pollIntervalMs || Number(process.env.TWITTERAPI_IO_POLL_MS || process.env.TWITTERAPI_IO_SOURCE_REFRESH_MS || 5000)
  }

  private runtimeTweetsPerSource(): number {
    return this.config.tweetsPerSource || Number(process.env.TWITTERAPI_IO_TWEETS_PER_SOURCE || 5)
  }

  private runtimeFetch(): typeof fetch {
    return this.config.fetchImpl || globalThis.fetch
  }
}
