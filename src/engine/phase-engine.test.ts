import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { PhaseEngine } from './phase-engine.js'
import { StateManager } from '../state/state-manager.js'
import { AuditLogger } from '../logger/audit-logger.js'
import { DEFAULT_STC_CONFIG } from '../config/config-loader.js'
import type { GuardianConfig, FeatureState } from '../state/types.js'

function createFeature(overrides?: Partial<FeatureState>): FeatureState {
  return {
    spec_path: '.claude/specs/test.md',
    registration_source: 'registered_explicitly',
    current_phase: 'specify',
    current_step: 1,
    total_steps: 3,
    phases_completed: [],
    phases_skipped: {},
    phases_satisfied: {},
    created_at: '2026-03-10T12:00:00Z',
    updated_at: '2026-03-10T12:00:00Z',
    ...overrides,
  }
}

describe('phase-engine', () => {
  let tmpDir: string
  let stateManager: StateManager
  let auditLogger: AuditLogger
  let engine: PhaseEngine

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardian-engine-'))
    stateManager = new StateManager(tmpDir)
    auditLogger = new AuditLogger(tmpDir)
    engine = new PhaseEngine(stateManager, auditLogger, structuredClone(DEFAULT_STC_CONFIG) as GuardianConfig)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // --- phase_status ---

  describe('getStatus', () => {
    // HP-2: Просмотр статуса
    it('возвращает текущую фазу, шаг и что дальше', () => {
      stateManager.updateState(s => {
        s.features['my-feature'] = createFeature({
          current_phase: 'code',
          current_step: 3,
          total_steps: 5,
          phases_completed: ['specify', 'clarify', 'plan', 'test'],
        })
        s.active_feature = 'my-feature'
      })

      const status = engine.getStatus()

      expect(status.feature).toBe('my-feature')
      expect(status.current_phase).toBe('code')
      expect(status.current_step).toBe(3)
      expect(status.total_steps).toBe(5)
      expect(status.next_phase).toBe('verify')
      expect(status.is_done).toBe(false)
    })

    it('next_phase = null на terminal фазе', () => {
      stateManager.updateState(s => {
        s.features['my-feature'] = createFeature({
          current_phase: 'commit',
          phases_completed: ['specify', 'clarify', 'plan', 'test', 'code', 'verify'],
        })
        s.active_feature = 'my-feature'
      })

      const status = engine.getStatus()

      expect(status.current_phase).toBe('commit')
      expect(status.next_phase).toBeNull()
    })

    it('нет активной фичи → ошибка', () => {
      stateManager.getState() // init

      expect(() => engine.getStatus()).toThrow(/активн/i)
    })

    it('активная фича не найдена в state → ошибка', () => {
      stateManager.updateState(s => {
        s.active_feature = 'ghost-feature'
      })

      expect(() => engine.getStatus()).toThrow(/не найдена/i)
    })
  })

  // --- phase_advance ---

  describe('advance', () => {
    // Нормальный advance
    it('переход на следующую фазу', () => {
      stateManager.updateState(s => {
        s.features['my-feature'] = createFeature({ current_phase: 'specify' })
        s.active_feature = 'my-feature'
      })

      const result = engine.advance()

      expect(result.previous_phase).toBe('specify')
      expect(result.current_phase).toBe('clarify')
      expect(result.action).toBe('completed')
      expect(result.is_done).toBe(false)
    })

    it('advance обновляет state на диске', () => {
      stateManager.updateState(s => {
        s.features['my-feature'] = createFeature({ current_phase: 'specify' })
        s.active_feature = 'my-feature'
      })

      engine.advance()

      // Перечитываем с диска
      const freshState = new StateManager(tmpDir).getState()
      const feature = freshState.features['my-feature']

      expect(feature.current_phase).toBe('clarify')
      expect(feature.phases_completed).toContain('specify')
    })

    it('advance логирует событие в audit log', () => {
      stateManager.updateState(s => {
        s.features['my-feature'] = createFeature({ current_phase: 'specify' })
        s.active_feature = 'my-feature'
      })

      engine.advance()

      const events = auditLogger.getEvents()
      expect(events).toHaveLength(1)
      expect(events[0].feature).toBe('my-feature')
      expect(events[0].action).toBe('phase_advance')
      expect(events[0].phase).toBe('specify')
      expect(events[0].details).toHaveProperty('next_phase', 'clarify')
    })

    // V-1: advance всегда последовательный — перескок невозможен by design
    it('advance идёт строго на следующую фазу', () => {
      stateManager.updateState(s => {
        s.features['my-feature'] = createFeature({
          current_phase: 'plan',
          phases_completed: ['specify', 'clarify'],
        })
        s.active_feature = 'my-feature'
      })

      // advance с plan → test (next), не code
      const result = engine.advance()

      expect(result.current_phase).toBe('test')
      expect(result.current_phase).not.toBe('code')
    })

    // BR-1: Skip non-required фазы
    it('skip non-required фазы с причиной', () => {
      stateManager.updateState(s => {
        s.features['my-feature'] = createFeature({
          current_phase: 'clarify', // required: false
        })
        s.active_feature = 'my-feature'
      })

      const skipReason = 'Багфикс — clarify не нужен, задача описана в спеке полностью и однозначно'
      const result = engine.advance({ skip_reason: skipReason })

      expect(result.action).toBe('skipped')
      expect(result.previous_phase).toBe('clarify')
      expect(result.current_phase).toBe('plan')

      // Проверяем state
      const state = stateManager.getState()
      const feature = state.features['my-feature']
      expect(feature.phases_skipped['clarify']).toBeDefined()
      expect(feature.phases_skipped['clarify'].reason).toBe(skipReason)
    })

    it('skip логирует причину в audit log', () => {
      stateManager.updateState(s => {
        s.features['my-feature'] = createFeature({ current_phase: 'clarify' })
        s.active_feature = 'my-feature'
      })

      const skipReason = 'Clarify не нужен — спека детализирована, вопросов нет, всё однозначно'
      engine.advance({ skip_reason: skipReason })

      const events = auditLogger.getEvents()
      expect(events[0].action).toBe('phase_skip')
      expect(events[0].details).toHaveProperty('reason', skipReason)
    })

    // EC-3: Skip required фазы → ошибка
    it('нельзя skip required фазу', () => {
      stateManager.updateState(s => {
        s.features['my-feature'] = createFeature({
          current_phase: 'verify', // required: true
          phases_completed: ['specify', 'clarify', 'plan', 'test', 'code'],
        })
        s.active_feature = 'my-feature'
      })

      expect(() => {
        engine.advance({ skip_reason: 'Хочу пропустить verify — мне лень запускать ревью и проверки' })
      }).toThrow(/обязательна|required/i)
    })

    // BR-2: Satisfy satisfiable фазы
    it('satisfy satisfiable фазы с evidence', () => {
      stateManager.updateState(s => {
        s.features['my-feature'] = createFeature({
          current_phase: 'test', // satisfiable: true
          total_steps: 0, // single-step — satisfy допустим
          phases_completed: ['specify', 'clarify', 'plan'],
        })
        s.active_feature = 'my-feature'
      })

      const result = engine.advance({ satisfy_evidence: 'Existing tests in tests/feature.test.ts fully cover all scenarios for this step. Проверено: 12 тестов покрывают create/update/delete/list use cases. Новых use cases в этом шаге нет — только конфиг и типы. Тестировать нечего.' })

      expect(result.action).toBe('satisfied')
      expect(result.previous_phase).toBe('test')
      expect(result.current_phase).toBe('code')

      const state = stateManager.getState()
      const feature = state.features['my-feature']
      expect(feature.phases_satisfied['test']).toBeDefined()
      expect(feature.phases_satisfied['test'].evidence).toContain('Existing tests')
    })

    it('satisfy не-satisfiable фазы → ошибка', () => {
      stateManager.updateState(s => {
        s.features['my-feature'] = createFeature({
          current_phase: 'code', // required, not satisfiable
          phases_completed: ['specify', 'clarify', 'plan', 'test'],
        })
        s.active_feature = 'my-feature'
      })

      expect(() => {
        engine.advance({ satisfy_evidence: 'some evidence' })
      }).toThrow(/satisfy/i)
    })

    // Terminal фаза
    it('advance на terminal фазе → done', () => {
      stateManager.updateState(s => {
        s.features['my-feature'] = createFeature({
          current_phase: 'commit', // terminal
          current_step: 0,
          total_steps: 0,
          phases_completed: ['specify', 'clarify', 'plan', 'test', 'code', 'verify'],
        })
        s.active_feature = 'my-feature'
      })

      const result = engine.advance()

      expect(result.action).toBe('completed')
      expect(result.is_done).toBe(true)
      expect(result.current_phase).toBeNull()
    })

    it('advance когда уже done → ошибка', () => {
      stateManager.updateState(s => {
        s.features['my-feature'] = createFeature({
          current_phase: 'done',
          phases_completed: ['specify', 'clarify', 'plan', 'test', 'code', 'verify', 'commit'],
        })
        s.active_feature = 'my-feature'
      })

      expect(() => engine.advance()).toThrow(/done|завершена/i)
    })

    // HP-1: Полный цикл одной фичи (STC pipeline)
    it('полный цикл — все фазы по порядку', () => {
      stateManager.updateState(s => {
        s.features['full-cycle'] = createFeature({
          current_phase: 'specify',
          current_step: 0,
          total_steps: 0,
        })
        s.active_feature = 'full-cycle'
      })

      // specify → clarify
      let result = engine.advance()
      expect(result.current_phase).toBe('clarify')

      // clarify → plan (skip)
      result = engine.advance({ skip_reason: 'Clarify не нужен — спека полностью описывает задачу, вопросов нет' })
      expect(result.current_phase).toBe('plan')

      // plan → test
      result = engine.advance()
      expect(result.current_phase).toBe('test')

      // test → code (satisfy)
      result = engine.advance({ satisfy_evidence: 'Tests already exist in test suite and cover all scenarios for this config-only step. Проверено: тесты в tests/feature.test.ts покрывают все use cases (12 тестов). Этот шаг — только конфиг и типы, новой логики нет.' })
      expect(result.current_phase).toBe('code')

      // code → verify
      result = engine.advance()
      expect(result.current_phase).toBe('verify')

      // verify → commit (нужен verify_passed для hard gate v0.5)
      stateManager.updateState(s => {
        s.features['full-cycle'].verify_passed = true
      })
      result = engine.advance()
      expect(result.current_phase).toBe('commit')

      // commit (terminal) → done
      result = engine.advance()
      expect(result.is_done).toBe(true)
      expect(result.current_phase).toBeNull()

      // Все события залогированы
      const events = auditLogger.getEvents()
      expect(events).toHaveLength(7) // 7 transitions

      // State сохранён
      const state = stateManager.getState()
      const feature = state.features['full-cycle']
      expect(feature.current_phase).toBe('done')
      expect(feature.phases_completed).toContain('commit')
      expect(feature.phases_skipped).toHaveProperty('clarify')
      expect(feature.phases_satisfied).toHaveProperty('test')
    })

    // HP-5 partial: кастомный pipeline
    it('работает с кастомным pipeline', () => {
      const customConfig: GuardianConfig = {
        pipeline: {
          name: 'content',
          phases: [
            { name: 'research', required: true },
            { name: 'draft', required: true },
            { name: 'review', required: true },
            { name: 'publish', terminal: true },
          ],
        },
      }
      const customEngine = new PhaseEngine(stateManager, auditLogger, customConfig)

      stateManager.updateState(s => {
        s.features['article'] = createFeature({ current_phase: 'research' })
        s.active_feature = 'article'
      })

      let result = customEngine.advance()
      expect(result.current_phase).toBe('draft')

      result = customEngine.advance()
      expect(result.current_phase).toBe('review')

      result = customEngine.advance()
      expect(result.current_phase).toBe('publish')

      result = customEngine.advance()
      expect(result.is_done).toBe(true)
    })

    it('нет активной фичи → ошибка', () => {
      stateManager.getState()

      expect(() => engine.advance()).toThrow(/активн/i)
    })

    it('skip без причины → ошибка', () => {
      stateManager.updateState(s => {
        s.features['my-feature'] = createFeature({ current_phase: 'clarify' })
        s.active_feature = 'my-feature'
      })

      expect(() => {
        engine.advance({ skip_reason: '' })
      }).toThrow(/причин|reason/i)
    })

    it('satisfy без evidence → ошибка', () => {
      stateManager.updateState(s => {
        s.features['my-feature'] = createFeature({ current_phase: 'test' })
        s.active_feature = 'my-feature'
      })

      expect(() => {
        engine.advance({ satisfy_evidence: '' })
      }).toThrow(/evidence/i)
    })

    it('skip_reason + satisfy_evidence одновременно → ошибка', () => {
      stateManager.updateState(s => {
        s.features['my-feature'] = createFeature({ current_phase: 'clarify' })
        s.active_feature = 'my-feature'
      })

      expect(() => {
        engine.advance({ skip_reason: 'Причина пропуска — подробное описание почему фаза не нужна в этот раз', satisfy_evidence: 'Evidence — подробное описание почему тесты не нужны, файлы перечислены, логика описана, всё объяснено' })
      }).toThrow(/одновременно/i)
    })
  })

  describe('getStatus edge cases', () => {
    it('getStatus для done-фичи', () => {
      stateManager.updateState(s => {
        s.features['my-feature'] = createFeature({
          current_phase: 'done',
          phases_completed: ['specify', 'clarify', 'plan', 'test', 'code', 'verify', 'commit'],
        })
        s.active_feature = 'my-feature'
      })

      const status = engine.getStatus()

      expect(status.is_done).toBe(true)
      expect(status.current_phase).toBe('done')
      expect(status.next_phase).toBeNull()
    })
  })
})
