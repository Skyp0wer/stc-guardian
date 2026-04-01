import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, appendFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AuditLogger } from './audit-logger.js'
import type { AuditEvent } from '../state/types.js'

describe('audit-logger', () => {
  let tmpDir: string
  let logger: AuditLogger

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardian-log-'))
    logger = new AuditLogger(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('создаёт .stc/ и log.jsonl при первой записи', () => {
    logger.log({
      timestamp: '2026-03-10T12:00:00Z',
      feature: 'test-feature',
      action: 'phase_advance',
      phase: 'specify',
    })

    const logPath = join(tmpDir, '.stc', 'log.jsonl')
    expect(existsSync(logPath)).toBe(true)
  })

  it('записывает событие как одну JSON-строку', () => {
    const event: AuditEvent = {
      timestamp: '2026-03-10T12:00:00Z',
      feature: 'test-feature',
      action: 'phase_advance',
      phase: 'specify',
    }

    logger.log(event)

    const logPath = join(tmpDir, '.stc', 'log.jsonl')
    const content = readFileSync(logPath, 'utf-8').trim()
    const parsed = JSON.parse(content)

    expect(parsed.feature).toBe('test-feature')
    expect(parsed.action).toBe('phase_advance')
    expect(parsed.phase).toBe('specify')
    expect(parsed.timestamp).toBe('2026-03-10T12:00:00Z')
  })

  it('append — несколько событий = несколько строк', () => {
    logger.log({
      timestamp: '2026-03-10T12:00:00Z',
      feature: 'feat-a',
      action: 'phase_advance',
      phase: 'specify',
    })

    logger.log({
      timestamp: '2026-03-10T12:01:00Z',
      feature: 'feat-a',
      action: 'phase_advance',
      phase: 'clarify',
    })

    logger.log({
      timestamp: '2026-03-10T12:02:00Z',
      feature: 'feat-b',
      action: 'feature_register',
    })

    const logPath = join(tmpDir, '.stc', 'log.jsonl')
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n')

    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]).phase).toBe('specify')
    expect(JSON.parse(lines[1]).phase).toBe('clarify')
    expect(JSON.parse(lines[2]).action).toBe('feature_register')
  })

  it('сохраняет details если переданы', () => {
    logger.log({
      timestamp: '2026-03-10T12:00:00Z',
      feature: 'test-feature',
      action: 'phase_skip',
      phase: 'clarify',
      details: { reason: 'багфикс, clarify не нужен' },
    })

    const logPath = join(tmpDir, '.stc', 'log.jsonl')
    const parsed = JSON.parse(readFileSync(logPath, 'utf-8').trim())

    expect(parsed.details.reason).toBe('багфикс, clarify не нужен')
  })

  it('getEvents возвращает все события', () => {
    logger.log({
      timestamp: '2026-03-10T12:00:00Z',
      feature: 'feat-a',
      action: 'phase_advance',
      phase: 'specify',
    })

    logger.log({
      timestamp: '2026-03-10T12:01:00Z',
      feature: 'feat-b',
      action: 'feature_register',
    })

    const events = logger.getEvents()

    expect(events).toHaveLength(2)
    expect(events[0].feature).toBe('feat-a')
    expect(events[1].feature).toBe('feat-b')
  })

  it('getEvents с фильтром по feature', () => {
    logger.log({
      timestamp: '2026-03-10T12:00:00Z',
      feature: 'feat-a',
      action: 'phase_advance',
    })

    logger.log({
      timestamp: '2026-03-10T12:01:00Z',
      feature: 'feat-b',
      action: 'phase_advance',
    })

    logger.log({
      timestamp: '2026-03-10T12:02:00Z',
      feature: 'feat-a',
      action: 'phase_advance',
    })

    const events = logger.getEvents({ feature: 'feat-a' })

    expect(events).toHaveLength(2)
    expect(events.every(e => e.feature === 'feat-a')).toBe(true)
  })

  it('getEvents пустой файл → пустой массив', () => {
    const events = logger.getEvents()
    expect(events).toEqual([])
  })

  it('getEvents с limit — последние N событий', () => {
    for (let i = 0; i < 5; i++) {
      logger.log({
        timestamp: `2026-03-10T12:0${i}:00Z`,
        feature: 'feat-a',
        action: `action-${i}`,
      })
    }

    const events = logger.getEvents({ limit: 3 })

    expect(events).toHaveLength(3)
    expect(events[0].action).toBe('action-2')
    expect(events[2].action).toBe('action-4')
  })

  it('битая строка в JSONL — пропускается, валидные читаются', () => {
    logger.log({
      timestamp: '2026-03-10T12:00:00Z',
      feature: 'feat-a',
      action: 'phase_advance',
    })

    // Вручную дописываем битую строку
    const logPath = join(tmpDir, '.stc', 'log.jsonl')
    appendFileSync(logPath, '{broken json\n', 'utf-8')

    logger.log({
      timestamp: '2026-03-10T12:02:00Z',
      feature: 'feat-a',
      action: 'phase_advance',
    })

    const events = logger.getEvents()

    expect(events).toHaveLength(2)
    expect(events[0].timestamp).toBe('2026-03-10T12:00:00Z')
    expect(events[1].timestamp).toBe('2026-03-10T12:02:00Z')
  })

  it('комбинация фильтров feature + limit', () => {
    // 3 события feat-a, 2 события feat-b
    for (let i = 0; i < 3; i++) {
      logger.log({
        timestamp: `2026-03-10T12:0${i}:00Z`,
        feature: 'feat-a',
        action: `action-a-${i}`,
      })
    }
    for (let i = 0; i < 2; i++) {
      logger.log({
        timestamp: `2026-03-10T12:1${i}:00Z`,
        feature: 'feat-b',
        action: `action-b-${i}`,
      })
    }

    // Сначала фильтр по feature (3 события), потом limit 2 (последние 2)
    const events = logger.getEvents({ feature: 'feat-a', limit: 2 })

    expect(events).toHaveLength(2)
    expect(events[0].action).toBe('action-a-1')
    expect(events[1].action).toBe('action-a-2')
  })

  it('limit: 0 → пустой массив', () => {
    logger.log({
      timestamp: '2026-03-10T12:00:00Z',
      feature: 'feat-a',
      action: 'phase_advance',
    })

    const events = logger.getEvents({ limit: 0 })
    expect(events).toEqual([])
  })
})
