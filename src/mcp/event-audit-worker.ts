export interface EventAuditItem {
  automationIds: string[]
  tweetId: string
  sourceHandle: string
  text: string
  reason: string
  createdAt: number
}

export interface EventAuditWorkerOptions {
  enabled: boolean
  audit: (item: EventAuditItem) => Promise<void>
}

export class EventAuditWorker {
  private readonly enabled: boolean
  private readonly audit: (item: EventAuditItem) => Promise<void>
  private queue: Promise<void> = Promise.resolve()

  constructor(options: EventAuditWorkerOptions) {
    this.enabled = options.enabled
    this.audit = options.audit
  }

  enqueue(item: EventAuditItem): void {
    if (!this.enabled) return
    this.queue = this.queue.then(() => this.audit(item)).catch((error) => {
      console.warn('[EventAudit] audit failed', error)
    })
  }

  async drainForTests(): Promise<void> {
    await this.queue
  }
}
