import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { StateManager, StateValidationError } from './state/state-manager.js'
import { AuditLogger } from './logger/audit-logger.js'
import { FeatureManager } from './engine/feature-manager.js'
import type { GuardianConfig } from './state/types.js'

const testConfig: GuardianConfig = {
  pipeline: {
    name: 'stc',
    phases: [
      { name: 'specify', required: true },
      { name: 'clarify' },
      { name: 'plan' },
      { name: 'test', required: true },
      { name: 'code', required: true },
      { name: 'verify', required: true },
      { name: 'commit', required: true, terminal: true },
    ],
  },
}

// ═══════════════════════════════════════════
// State Validation (zod)
// ═══════════════════════════════════════════
describe('v1: state validation', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardian-v1-state-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('невалидный JSON → StateValidationError', () => {
    const stcDir = join(tmpDir, '.stc')
    mkdirSync(stcDir, { recursive: true })
    writeFileSync(join(stcDir, 'state.json'), '{broken json!!!', 'utf-8')

    const manager = new StateManager(tmpDir)
    expect(() => manager.getState()).toThrow(StateValidationError)
    expect(() => manager.getState()).toThrow(/невалидный JSON/)
  })

  it('невалидная структура (отсутствует version) → StateValidationError', () => {
    const stcDir = join(tmpDir, '.stc')
    mkdirSync(stcDir, { recursive: true })
    writeFileSync(stcDir + '/state.json', JSON.stringify({
      pipeline: 'stc',
      features: {},
      active_feature: null,
    }), 'utf-8')

    const manager = new StateManager(tmpDir)
    expect(() => manager.getState()).toThrow(StateValidationError)
  })

  it('невалидная feature (отсутствует current_phase) → StateValidationError с issues', () => {
    const stcDir = join(tmpDir, '.stc')
    mkdirSync(stcDir, { recursive: true })
    writeFileSync(stcDir + '/state.json', JSON.stringify({
      version: 1,
      pipeline: 'stc',
      features: {
        'bad-feature': {
          spec_path: null,
          registration_source: 'registered_explicitly',
          // current_phase отсутствует
          current_step: 0,
          total_steps: 0,
          phases_completed: [],
          phases_skipped: {},
          phases_satisfied: {},
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
        },
      },
      active_feature: 'bad-feature',
    }), 'utf-8')

    const manager = new StateManager(tmpDir)
    try {
      manager.getState()
      expect.unreachable('должен был бросить ошибку')
    } catch (e) {
      expect(e).toBeInstanceOf(StateValidationError)
      const err = e as StateValidationError
      expect(err.issues.length).toBeGreaterThan(0)
      expect(err.issues.some(i => i.includes('current_phase'))).toBe(true)
    }
  })

  it('невалидный registration_source → StateValidationError', () => {
    const stcDir = join(tmpDir, '.stc')
    mkdirSync(stcDir, { recursive: true })
    writeFileSync(stcDir + '/state.json', JSON.stringify({
      version: 1,
      pipeline: 'stc',
      features: {
        'test': {
          spec_path: null,
          registration_source: 'unknown_source',
          current_phase: 'specify',
          current_step: 0,
          total_steps: 0,
          phases_completed: [],
          phases_skipped: {},
          phases_satisfied: {},
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
        },
      },
      active_feature: null,
    }), 'utf-8')

    const manager = new StateManager(tmpDir)
    expect(() => manager.getState()).toThrow(StateValidationError)
  })

  it('валидный state проходит проверку', () => {
    const stcDir = join(tmpDir, '.stc')
    mkdirSync(stcDir, { recursive: true })
    writeFileSync(stcDir + '/state.json', JSON.stringify({
      version: 1,
      pipeline: 'stc',
      features: {
        'good-feature': {
          spec_path: '/path/to/spec.md',
          registration_source: 'registered_explicitly',
          current_phase: 'specify',
          current_step: 0,
          total_steps: 3,
          steps: [
            { name: 'step-1', status: 'active' },
            { name: 'step-2', status: 'pending' },
            { name: 'step-3', status: 'pending' },
          ],
          verify_passed: false,
          phases_completed: [],
          phases_skipped: {},
          phases_satisfied: {},
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      },
      active_feature: 'good-feature',
    }), 'utf-8')

    const manager = new StateManager(tmpDir)
    const state = manager.getState()
    expect(state.features['good-feature'].current_phase).toBe('specify')
    expect(state.features['good-feature'].steps).toHaveLength(3)
  })
})

// ═══════════════════════════════════════════
// Log Rotation
// ═══════════════════════════════════════════
describe('v1: log rotation', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardian-v1-log-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('ротация при превышении порога', () => {
    // Маленький порог — 200 байт
    const logger = new AuditLogger(tmpDir, { maxSizeBytes: 200 })
    const logPath = join(tmpDir, '.stc', 'log.jsonl')
    const archivePath = join(tmpDir, '.stc', 'log.1.jsonl')

    // Пишем события до превышения порога
    for (let i = 0; i < 5; i++) {
      logger.log({
        timestamp: `2026-03-10T12:0${i}:00Z`,
        feature: 'feat-a',
        action: `action-${i}`,
      })
    }

    // log.1.jsonl должен появиться (ротация произошла)
    expect(existsSync(archivePath)).toBe(true)
    // Текущий log.jsonl должен содержать только свежие события
    const currentContent = readFileSync(logPath, 'utf-8').trim()
    const currentLines = currentContent.split('\n').filter(l => l.length > 0)
    expect(currentLines.length).toBeLessThan(5)
  })

  it('без превышения порога ротации нет', () => {
    const logger = new AuditLogger(tmpDir, { maxSizeBytes: 1_000_000 })
    const archivePath = join(tmpDir, '.stc', 'log.1.jsonl')

    logger.log({
      timestamp: '2026-03-10T12:00:00Z',
      feature: 'feat-a',
      action: 'action-0',
    })

    expect(existsSync(archivePath)).toBe(false)
  })

  it('каскадная ротация: log.1 → log.2', () => {
    const logger = new AuditLogger(tmpDir, { maxSizeBytes: 100 })
    const stcDir = join(tmpDir, '.stc')

    // Пишем много событий чтобы вызвать несколько ротаций
    for (let i = 0; i < 20; i++) {
      logger.log({
        timestamp: `2026-03-10T12:${String(i).padStart(2, '0')}:00Z`,
        feature: 'feat-a',
        action: `action-${i}`,
      })
    }

    expect(existsSync(join(stcDir, 'log.1.jsonl'))).toBe(true)
    expect(existsSync(join(stcDir, 'log.2.jsonl'))).toBe(true)
  })

  it('максимум 3 архива — log.4.jsonl не создаётся', () => {
    const logger = new AuditLogger(tmpDir, { maxSizeBytes: 50 })
    const stcDir = join(tmpDir, '.stc')

    for (let i = 0; i < 50; i++) {
      logger.log({
        timestamp: `2026-03-10T12:${String(i).padStart(2, '0')}:00Z`,
        feature: 'feat-a',
        action: `action-${i}`,
      })
    }

    expect(existsSync(join(stcDir, 'log.3.jsonl'))).toBe(true)
    expect(existsSync(join(stcDir, 'log.4.jsonl'))).toBe(false)
  })

  it('getEvents читает только текущий лог после ротации', () => {
    const logger = new AuditLogger(tmpDir, { maxSizeBytes: 200 })

    for (let i = 0; i < 10; i++) {
      logger.log({
        timestamp: `2026-03-10T12:${String(i).padStart(2, '0')}:00Z`,
        feature: 'feat-a',
        action: `action-${i}`,
      })
    }

    const events = logger.getEvents()
    // После ротации текущий лог содержит только свежие события
    expect(events.length).toBeLessThan(10)
    expect(events.length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════
// Path Traversal Fix
// ═══════════════════════════════════════════
describe('v1: path traversal fix', () => {
  let tmpDir: string
  let stateManager: StateManager
  let auditLogger: AuditLogger

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardian-v1-path-'))
    stateManager = new StateManager(tmpDir)
    auditLogger = new AuditLogger(tmpDir)
    stateManager.getState() // init
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('path traversal за пределы проекта → ошибка', () => {
    const fm = new FeatureManager(stateManager, auditLogger, testConfig, tmpDir)

    expect(() => {
      fm.scanSpecs(join(tmpDir, '..', '..', 'etc'))
    }).toThrow(/за пределы проекта/)
  })

  it('абсолютный путь вне проекта → ошибка', () => {
    const fm = new FeatureManager(stateManager, auditLogger, testConfig, tmpDir)

    expect(() => {
      fm.scanSpecs('/tmp/evil-specs')
    }).toThrow(/за пределы проекта/)
  })

  it('нормальный путь внутри проекта → работает', () => {
    const specsDir = join(tmpDir, '.claude', 'specs')
    mkdirSync(specsDir, { recursive: true })
    writeFileSync(join(specsDir, 'my-feature.md'), '# Feature', 'utf-8')

    const fm = new FeatureManager(stateManager, auditLogger, testConfig, tmpDir)
    const discovered = fm.scanSpecs(specsDir)

    expect(discovered).toContain('my-feature')
  })

  it('без projectDir — path traversal не блокируется (backwards compat)', () => {
    const fm = new FeatureManager(stateManager, auditLogger, testConfig)

    // Без projectDir валидация пути не работает — обратная совместимость
    // Просто проверяем что не бросает ошибку path traversal
    const result = fm.scanSpecs('/nonexistent/path')
    expect(result).toEqual([])
  })

  it('путь с . и .. внутри проекта → нормализуется и работает', () => {
    const specsDir = join(tmpDir, 'subdir', '..', '.claude', 'specs')
    mkdirSync(join(tmpDir, '.claude', 'specs'), { recursive: true })
    writeFileSync(join(tmpDir, '.claude', 'specs', 'test-feat.md'), '# Test', 'utf-8')

    const fm = new FeatureManager(stateManager, auditLogger, testConfig, tmpDir)
    const discovered = fm.scanSpecs(specsDir)

    expect(discovered).toContain('test-feat')
  })
})
