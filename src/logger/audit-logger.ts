import { appendFileSync, readFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { AuditEvent } from '../state/types.js'

/** Порог ротации по умолчанию: 1 MB */
const DEFAULT_MAX_SIZE_BYTES = 1_048_576
/** Максимум архивных файлов */
const MAX_ARCHIVES = 3

export interface EventFilter {
  feature?: string
  limit?: number
}

export interface AuditLoggerOptions {
  maxSizeBytes?: number
}

/**
 * Append-only logger: записывает события в .stc/log.jsonl.
 * Одна строка = один JSON-объект (JSONL формат).
 * При превышении maxSizeBytes — ротация: log.jsonl → log.1.jsonl → log.2.jsonl → ...
 */
export class AuditLogger {
  private readonly logPath: string
  private readonly stcDir: string
  private readonly maxSizeBytes: number

  constructor(projectDir: string, options?: AuditLoggerOptions) {
    this.stcDir = join(projectDir, '.stc')
    this.logPath = join(this.stcDir, 'log.jsonl')
    this.maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES

    if (!existsSync(this.stcDir)) {
      mkdirSync(this.stcDir, { recursive: true })
    }
  }

  /** Записать событие в лог. Ротирует если превышен порог. */
  log(event: AuditEvent): void {
    this.rotateIfNeeded()
    appendFileSync(this.logPath, JSON.stringify(event) + '\n', 'utf-8')
  }

  /** Ротация: log.jsonl → log.1.jsonl, log.1 → log.2, ... Удаляет старше MAX_ARCHIVES. */
  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.logPath)) return
      const size = statSync(this.logPath).size
      if (size < this.maxSizeBytes) return

      // Сдвигаем архивы: log.3 удаляем, log.2→log.3, log.1→log.2, log→log.1
      for (let i = MAX_ARCHIVES; i >= 1; i--) {
        const archivePath = join(this.stcDir, `log.${i}.jsonl`)
        if (i === MAX_ARCHIVES) {
          if (existsSync(archivePath)) unlinkSync(archivePath)
        } else {
          const nextPath = join(this.stcDir, `log.${i + 1}.jsonl`)
          if (existsSync(archivePath)) renameSync(archivePath, nextPath)
        }
      }

      renameSync(this.logPath, join(this.stcDir, 'log.1.jsonl'))
    } catch {
      // TOCTOU: файл мог быть удалён/перемещён другим процессом — не ломаем запись
    }
  }

  /** Прочитать события из лога с опциональным фильтром */
  getEvents(filter?: EventFilter): AuditEvent[] {
    if (!existsSync(this.logPath)) {
      return []
    }

    const content = readFileSync(this.logPath, 'utf-8').trim()
    if (content.length === 0) {
      return []
    }

    let events: AuditEvent[] = content
      .split('\n')
      .reduce<AuditEvent[]>((acc, line) => {
        try {
          acc.push(JSON.parse(line) as AuditEvent)
        } catch {
          // Битая строка (крэш при записи, ручное редактирование) — пропускаем
        }
        return acc
      }, [])

    if (filter?.feature) {
      events = events.filter(e => e.feature === filter.feature)
    }

    if (filter?.limit !== undefined && filter.limit > 0) {
      events = events.slice(-filter.limit)
    } else if (filter?.limit === 0) {
      return []
    }

    return events
  }
}
