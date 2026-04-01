import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionLog } from './session-log.js'
import { AuditLogger } from '../logger/audit-logger.js'

describe('session-log', () => {
  let tmpDir: string
  let auditLogger: AuditLogger
  let sessionLog: SessionLog

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardian-session-'))
    auditLogger = new AuditLogger(tmpDir)
    sessionLog = new SessionLog(auditLogger)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('пустой лог → пустой результат', () => {
    const result = sessionLog.getLog()

    expect(result.events).toHaveLength(0)
    expect(result.total).toBe(0)
  })

  it('возвращает все события', () => {
    auditLogger.log({
      timestamp: '2026-03-10T12:00:00Z',
      feature: 'feat-a',
      action: 'phase_advance',
      phase: 'specify',
    })
    auditLogger.log({
      timestamp: '2026-03-10T12:01:00Z',
      feature: 'feat-a',
      action: 'phase_advance',
      phase: 'clarify',
    })

    const result = sessionLog.getLog()

    expect(result.events).toHaveLength(2)
    expect(result.total).toBe(2)
    expect(result.events[0].action).toBe('phase_advance')
    expect(result.events[0].phase).toBe('specify')
  })

  it('фильтр по feature', () => {
    auditLogger.log({
      timestamp: '2026-03-10T12:00:00Z',
      feature: 'feat-a',
      action: 'phase_advance',
      phase: 'specify',
    })
    auditLogger.log({
      timestamp: '2026-03-10T12:01:00Z',
      feature: 'feat-b',
      action: 'phase_advance',
      phase: 'specify',
    })
    auditLogger.log({
      timestamp: '2026-03-10T12:02:00Z',
      feature: 'feat-a',
      action: 'phase_skip',
      phase: 'clarify',
    })

    const result = sessionLog.getLog({ feature: 'feat-a' })

    expect(result.events).toHaveLength(2)
    expect(result.total).toBe(2)
    expect(result.events.every(e => e.feature === 'feat-a')).toBe(true)
  })

  it('limit ограничивает количество (последние N)', () => {
    for (let i = 0; i < 10; i++) {
      auditLogger.log({
        timestamp: `2026-03-10T12:${String(i).padStart(2, '0')}:00Z`,
        feature: 'feat-a',
        action: 'phase_advance',
        phase: `phase-${i}`,
      })
    }

    const result = sessionLog.getLog({ limit: 3 })

    expect(result.events).toHaveLength(3)
    expect(result.total).toBe(3)
    // Последние 3 события
    expect(result.events[0].phase).toBe('phase-7')
    expect(result.events[2].phase).toBe('phase-9')
  })

  it('limit: 0 → пустой результат', () => {
    auditLogger.log({
      timestamp: '2026-03-10T12:00:00Z',
      feature: 'feat-a',
      action: 'phase_advance',
    })

    const result = sessionLog.getLog({ limit: 0 })

    expect(result.events).toHaveLength(0)
    expect(result.total).toBe(0)
  })

  it('feature + limit вместе', () => {
    auditLogger.log({
      timestamp: '2026-03-10T12:00:00Z',
      feature: 'feat-a',
      action: 'feature_register',
    })
    auditLogger.log({
      timestamp: '2026-03-10T12:01:00Z',
      feature: 'feat-b',
      action: 'feature_register',
    })
    auditLogger.log({
      timestamp: '2026-03-10T12:02:00Z',
      feature: 'feat-a',
      action: 'phase_advance',
      phase: 'specify',
    })
    auditLogger.log({
      timestamp: '2026-03-10T12:03:00Z',
      feature: 'feat-a',
      action: 'phase_advance',
      phase: 'clarify',
    })

    const result = sessionLog.getLog({ feature: 'feat-a', limit: 1 })

    expect(result.events).toHaveLength(1)
    expect(result.events[0].phase).toBe('clarify')
  })

  // HP-1: Полный цикл — audit trail отражает все transitions
  it('HP-1: полный цикл фичи отражён в audit trail', () => {
    const phases = ['specify', 'clarify', 'plan', 'test', 'code', 'verify', 'commit']

    auditLogger.log({
      timestamp: '2026-03-10T12:00:00Z',
      feature: 'full-cycle',
      action: 'feature_register',
    })

    for (let i = 0; i < phases.length; i++) {
      auditLogger.log({
        timestamp: `2026-03-10T12:${String(i + 1).padStart(2, '0')}:00Z`,
        feature: 'full-cycle',
        action: i === 1 ? 'phase_skip' : 'phase_advance',
        phase: phases[i],
        details: i === 1 ? { reason: 'не нужен' } : { next_phase: phases[i + 1] ?? null },
      })
    }

    const result = sessionLog.getLog({ feature: 'full-cycle' })

    expect(result.total).toBe(8) // register + 7 transitions
    expect(result.events[0].action).toBe('feature_register')
    expect(result.events[1].action).toBe('phase_advance')
    expect(result.events[2].action).toBe('phase_skip')

    // details сохранены
    expect(result.events[2].details).toHaveProperty('reason', 'не нужен')
  })

  it('отрицательный limit → 0 (пустой результат)', () => {
    auditLogger.log({
      timestamp: '2026-03-10T12:00:00Z',
      feature: 'feat-a',
      action: 'phase_advance',
    })

    const result = sessionLog.getLog({ limit: -5 })

    expect(result.events).toHaveLength(0)
    expect(result.total).toBe(0)
  })

  it('limit clamp до 1000', () => {
    auditLogger.log({
      timestamp: '2026-03-10T12:00:00Z',
      feature: 'feat-a',
      action: 'phase_advance',
    })

    // limit > 1000 → clamped to 1000, но у нас 1 событие — вернётся 1
    const result = sessionLog.getLog({ limit: 99999 })

    expect(result.events).toHaveLength(1)
  })

  it('события содержат все поля AuditEvent', () => {
    auditLogger.log({
      timestamp: '2026-03-10T12:00:00Z',
      feature: 'feat-a',
      action: 'phase_satisfy',
      phase: 'test',
      details: { evidence: 'existing tests' },
    })

    const result = sessionLog.getLog()

    expect(result.events[0]).toEqual({
      timestamp: '2026-03-10T12:00:00Z',
      feature: 'feat-a',
      action: 'phase_satisfy',
      phase: 'test',
      details: { evidence: 'existing tests' },
    })
  })
})
