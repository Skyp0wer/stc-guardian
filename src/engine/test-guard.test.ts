import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { StateManager } from '../state/state-manager.js'
import { AuditLogger } from '../logger/audit-logger.js'
import { PhaseEngine } from './phase-engine.js'
import type { GuardianConfig } from '../state/types.js'

const configWithTestGuard: GuardianConfig = {
  pipeline: {
    name: 'stc',
    phases: [
      { name: 'specify', required: true },
      { name: 'test', required: true, satisfiable: true, satisfy_min_length: 50 },
      { name: 'code', required: true },
      { name: 'commit', terminal: true },
    ],
  },
}

function createFeature(sm: StateManager, name: string, phase: string) {
  sm.updateState(s => {
    s.features[name] = {
      spec_path: null,
      registration_source: 'registered_explicitly',
      current_phase: phase,
      current_step: 0,
      total_steps: 0,
      phases_completed: [],
      phases_skipped: {},
      phases_satisfied: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    s.active_feature = name
  })
}

describe('test guard: test фаза required + satisfiable', () => {
  let tmpDir: string
  let sm: StateManager
  let al: AuditLogger
  let engine: PhaseEngine

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardian-test-guard-'))
    sm = new StateManager(tmpDir)
    al = new AuditLogger(tmpDir)
    engine = new PhaseEngine(sm, al, configWithTestGuard)
    sm.getState() // init
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('skip test → ошибка (required)', () => {
    createFeature(sm, 'feat', 'test')

    expect(() => {
      engine.advance({ skip_reason: 'не хочу писать тесты' })
    }).toThrow(/обязательна.*required.*skip невозможен/)
  })

  it('advance test без тестов → ок (обычный advance)', () => {
    createFeature(sm, 'feat', 'test')

    const result = engine.advance()
    expect(result.current_phase).toBe('code')
    expect(result.action).toBe('completed')
  })

  it('satisfy test с коротким evidence → ошибка', () => {
    createFeature(sm, 'feat', 'test')

    expect(() => {
      engine.advance({ satisfy_evidence: 'нечего тестировать' })
    }).toThrow(/мин\. 50 символов/)
  })

  it('satisfy test с подробным evidence → ок', () => {
    createFeature(sm, 'feat', 'test')

    const evidence = 'Изменены только файлы конфигурации: stc.yaml, .env.example. Бизнес-логики нет, тестировать нечего.'
    const result = engine.advance({ satisfy_evidence: evidence })

    expect(result.action).toBe('satisfied')
    expect(result.current_phase).toBe('code')
  })

  it('satisfy test ровно 50 символов → ок', () => {
    createFeature(sm, 'feat', 'test')

    // Ровно 50 символов
    const evidence = '12345678901234567890123456789012345678901234567890'
    expect(evidence.length).toBe(50)

    const result = engine.advance({ satisfy_evidence: evidence })
    expect(result.action).toBe('satisfied')
  })

  it('satisfy test 49 символов → ошибка', () => {
    createFeature(sm, 'feat', 'test')

    const evidence = '1234567890123456789012345678901234567890123456789'
    expect(evidence.length).toBe(49)

    expect(() => {
      engine.advance({ satisfy_evidence: evidence })
    }).toThrow(/мин\. 50 символов/)
  })

  it('action_required для test содержит предупреждение о skip', () => {
    createFeature(sm, 'feat', 'test')

    const status = engine.getStatus()
    expect(status.action_required).toContain('НАПИШИ ТЕСТЫ')
    expect(status.action_required).toContain('Skip ЗАПРЕЩЁН')
    expect(status.action_required).toContain('satisfy_evidence')
  })
})
