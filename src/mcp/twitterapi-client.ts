import type { IncomingTweet, TweetSourceMeta } from './automation-types.js'

export interface TwitterApiIoClientConfig {
  apiKey?: string
}

export class TwitterApiIoClient {
  constructor(private readonly config: TwitterApiIoClientConfig) {}

  isEnabled(): boolean {
    return Boolean(this.config.apiKey)
  }

  async updateSources(_sources: TweetSourceMeta[]): Promise<void> {
    if (!this.isEnabled()) return
  }

  onTweet(_handler: (tweet: IncomingTweet) => Promise<void> | void): void {
    if (!this.isEnabled()) return
  }
}
