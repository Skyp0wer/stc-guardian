import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { StateManager } from '../state/state-manager.js'
import { AuditLogger } from '../logger/audit-logger.js'
import { StepManager } from './step-manager.js'
import { loadConfig } from '../config/config-loader.js'

function setupStepManager() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'guardian-step-'))
  mkdirSync(join(tmpDir, '.stc'), { recursive: true })
  const config = loadConfig(tmpDir)
  const stateManager = new StateManager(tmpDir)
  const auditLogger = new AuditLogger(tmpDir)
  const stepManager = new StepManager(stateManager, auditLogger)

  // Регистрируем фичу
  stateManager.updateState(s => {
    s.features['test-feature'] = {
      spec_path: null,
      registration_source: 'registered_explicitly',
      current_phase: 'specify',
      current_step: 0,
      total_steps: 0,
      phases_completed: [],
      phases_skipped: {},
      phases_satisfied: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    s.active_feature = 'test-feature'
  })

  return { stateManager, auditLogger, stepManager, tmpDir }
}

describe('StepManager', () => {
  // TS-9: step_set с именами шагов
  it('задаёт шаги с именами (TS-9)', () => {
    const { stepManager, stateManager } = setupStepManager()

    stepManager.setSteps({
      total_steps: 3,
      steps: [{ name: 'step 1' }, { name: 'step 2' }, { name: 'step 3' }],
    })

    const state = stateManager.getState()
    const feature = state.features['test-feature']
    expect(feature.total_steps).toBe(3)
    expect(feature.steps).toHaveLength(3)
    expect(feature.steps![0]).toEqual({ name: 'step 1', status: 'active' })
    expect(feature.steps![1]).toEqual({ name: 'step 2', status: 'pending' })
    expect(feature.steps![2]).toEqual({ name: 'step 3', status: 'pending' })
  })

  // TS-10: step_set только число
  it('задаёт только total_steps без имён (TS-10)', () => {
    const { stepManager, stateManager } = setupStepManager()

    stepManager.setSteps({ total_steps: 5 })

    const state = stateManager.getState()
    const feature = state.features['test-feature']
    expect(feature.total_steps).toBe(5)
    expect(feature.steps).toBeUndefined()
  })

  // TS-13: запрет step_set после начала цикла
  it('ошибка если current_step > 0 (TS-13)', () => {
    const { stepManager, stateManager } = setupStepManager()

    // Имитируем начатый цикл
    stateManager.updateState(s => {
      s.features['test-feature'].current_step = 1
      s.features['test-feature'].total_steps = 3
    })

    expect(() => stepManager.setSteps({ total_steps: 5 }))
      .toThrow('Нельзя менять шаги после начала цикла')
  })

  it('ошибка если нет активной фичи', () => {
    const { stepManager, stateManager } = setupStepManager()
    stateManager.updateState(s => { s.active_feature = null })

    expect(() => stepManager.setSteps({ total_steps: 3 }))
      .toThrow('Нет активной фичи')
  })

  it('ошибка если total_steps < 1', () => {
    const { stepManager } = setupStepManager()

    expect(() => stepManager.setSteps({ total_steps: 0 }))
      .toThrow('total_steps должен быть >= 1')
  })

  it('ошибка если steps.length !== total_steps', () => {
    const { stepManager } = setupStepManager()

    expect(() => stepManager.setSteps({
      total_steps: 3,
      steps: [{ name: 'step 1' }, { name: 'step 2' }],
    })).toThrow('Количество шагов (2) не совпадает с total_steps (3)')
  })

  it('логирует step_set в аудит', () => {
    const { stepManager, auditLogger } = setupStepManager()

    stepManager.setSteps({ total_steps: 2 })

    const events = auditLogger.getEvents({})
    const stepEvent = events.find(e => e.action === 'step_set')
    expect(stepEvent).toBeDefined()
    expect(stepEvent!.feature).toBe('test-feature')
    expect(stepEvent!.details?.total_steps).toBe(2)
  })
})
