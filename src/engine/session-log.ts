import type { AuditLogger } from '../logger/audit-logger.js'
import type { AuditEvent } from '../state/types.js'

export interface SessionLogParams {
  feature?: string
  limit?: number
}

export interface SessionLogResult {
  events: AuditEvent[]
  /** Количество возвращённых событий (после фильтрации и limit) */
  total: number
}

/**
 * Просмотр audit trail — обёртка над AuditLogger для MCP tool.
 */
export class SessionLog {
  constructor(private auditLogger: AuditLogger) {}

  getLog(params?: SessionLogParams): SessionLogResult {
    const feature = params?.feature?.slice(0, 200)
    const limit = params?.limit !== undefined
      ? Math.max(0, Math.min(Math.floor(params.limit), 1000))
      : undefined

    const events = this.auditLogger.getEvents({ feature, limit })

    return {
      events,
      total: events.length,
    }
  }
}
