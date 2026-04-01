import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { PhaseEngine } from './phase-engine.js'
import { StateManager } from '../state/state-manager.js'
import { AuditLogger } from '../logger/audit-logger.js'
import { DEFAULT_STC_CONFIG } from '../config/config-loader.js'
import type { FeatureState } from '../state/types.js'

function createFeature(overrides?: Partial<FeatureState>): FeatureState {
  return {
    spec_path: null,
    registration_source: 'registered_explicitly',
    current_phase: 'specify',
    current_step: 0,
    total_steps: 0,
    phases_completed: [],
    phases_skipped: {},
    phases_satisfied: {},
    created_at: '2026-03-10T12:00:00Z',
    updated_at: '2026-03-10T12:00:00Z',
    ...overrides,
  }
}

function setup() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'guardian-v05-'))
  mkdirSync(join(tmpDir, '.stc'), { recursive: true })
  const stateManager = new StateManager(tmpDir)
  const auditLogger = new AuditLogger(tmpDir)
  const engine = new PhaseEngine(stateManager, auditLogger, DEFAULT_STC_CONFIG)
  return { stateManager, auditLogger, engine, tmpDir }
}

describe('v0.5: Step Cycling', () => {
  // TS-1: commit с шагами → reset на test
  it('commit advance → next step, reset на test (TS-1)', () => {
    const { stateManager, engine } = setup()
    stateManager.updateState(s => {
      s.features['feat'] = createFeature({
        current_phase: 'commit',
        current_step: 0,
        total_steps: 3,
        phases_completed: ['specify', 'clarify', 'plan', 'test', 'code', 'verify'],
        steps: [
          { name: 'step 1', status: 'active' },
          { name: 'step 2', status: 'pending' },
          { name: 'step 3', status: 'pending' },
        ],
        verify_passed: true,
      })
      s.active_feature = 'feat'
    })

    const result = engine.advance()

    expect(result.is_done).toBe(false)
    expect(result.current_phase).toBe('test')

    const state = stateManager.getState()
    const feat = state.features['feat']
    expect(feat.current_step).toBe(1)
    expect(feat.current_phase).toBe('test')
    expect(feat.steps![0].status).toBe('done')
    expect(feat.steps![1].status).toBe('active')
  })

  // TS-2: последний шаг → done
  it('commit advance на последнем шаге → done (TS-2)', () => {
    const { stateManager, engine } = setup()
    stateManager.updateState(s => {
      s.features['feat'] = createFeature({
        current_phase: 'commit',
        current_step: 2,
        total_steps: 3,
        phases_completed: ['specify', 'clarify', 'plan', 'test', 'code', 'verify'],
        steps: [
          { name: 'step 1', status: 'done' },
          { name: 'step 2', status: 'done' },
          { name: 'step 3', status: 'active' },
        ],
        verify_passed: true,
      })
      s.active_feature = 'feat'
    })

    const result = engine.advance()

    expect(result.is_done).toBe(true)
    expect(result.current_phase).toBeNull()
  })

  // TS-3: без шагов (backward compat)
  it('commit без шагов → done как в v0 (TS-3)', () => {
    const { stateManager, engine } = setup()
    stateManager.updateState(s => {
      s.features['feat'] = createFeature({
        current_phase: 'commit',
        current_step: 0,
        total_steps: 0,
        phases_completed: ['specify', 'clarify', 'plan', 'test', 'code', 'verify'],
        verify_passed: true,
      })
      s.active_feature = 'feat'
    })

    const result = engine.advance()

    expect(result.is_done).toBe(true)
  })

  // TS-12: verify_passed reset после step cycle
  it('verify_passed сбрасывается при step cycle (TS-12)', () => {
    const { stateManager, engine } = setup()
    stateManager.updateState(s => {
      s.features['feat'] = createFeature({
        current_phase: 'commit',
        current_step: 0,
        total_steps: 3,
        phases_completed: ['specify', 'clarify', 'plan', 'test', 'code', 'verify'],
        verify_passed: true,
      })
      s.active_feature = 'feat'
    })

    engine.advance() // commit → step cycle → test

    const state = stateManager.getState()
    expect(state.features['feat'].verify_passed).toBe(false)
  })

  it('step cycle логирует step_cycle в аудит', () => {
    const { stateManager, engine, auditLogger } = setup()
    stateManager.updateState(s => {
      s.features['feat'] = createFeature({
        current_phase: 'commit',
        current_step: 0,
        total_steps: 2,
        phases_completed: ['specify', 'clarify', 'plan', 'test', 'code', 'verify'],
        verify_passed: true,
      })
      s.active_feature = 'feat'
    })

    engine.advance()

    const events = auditLogger.getEvents({})
    const cycleEvent = events.find(e => e.details?.step_cycle === true)
    expect(cycleEvent).toBeDefined()
    expect(cycleEvent!.details?.new_step).toBe(1)
  })

  // TS-11: phase_status с шагами
  it('phase_status показывает step info (TS-11)', () => {
    const { stateManager, engine } = setup()
    stateManager.updateState(s => {
      s.features['feat'] = createFeature({
        current_phase: 'test',
        current_step: 2,
        total_steps: 5,
        steps: [
          { name: 's1', status: 'done' },
          { name: 's2', status: 'done' },
          { name: 's3', status: 'active' },
          { name: 's4', status: 'pending' },
          { name: 's5', status: 'pending' },
        ],
      })
      s.active_feature = 'feat'
    })

    const status = engine.getStatus()

    expect(status.current_step).toBe(2)
    expect(status.total_steps).toBe(5)
    expect(status.step_info).toBeDefined()
    expect(status.step_info!.name).toBe('s3')
    expect(status.step_info!.display).toBe('Шаг 3/5: s3')
  })
})

describe('v0.5: Hard Verify Gate', () => {
  // TS-4: verify gate блокирует
  it('verify advance без verify_passed → ошибка (TS-4)', () => {
    const { stateManager, engine } = setup()
    stateManager.updateState(s => {
      s.features['feat'] = createFeature({
        current_phase: 'verify',
        phases_completed: ['specify', 'clarify', 'plan', 'test', 'code'],
        verify_passed: false,
      })
      s.active_feature = 'feat'
    })

    expect(() => engine.advance())
      .toThrow('Verify не пройден. Вызовите verify_checklist сначала')
  })

  // TS-5: verify gate пропускает
  it('verify advance с verify_passed = true → commit (TS-5)', () => {
    const { stateManager, engine } = setup()
    stateManager.updateState(s => {
      s.features['feat'] = createFeature({
        current_phase: 'verify',
        phases_completed: ['specify', 'clarify', 'plan', 'test', 'code'],
        verify_passed: true,
      })
      s.active_feature = 'feat'
    })

    const result = engine.advance()

    expect(result.current_phase).toBe('commit')
  })

  // Backward compat: verify_passed undefined → false
  it('verify_passed undefined (старый state) → блокирует', () => {
    const { stateManager, engine } = setup()
    stateManager.updateState(s => {
      s.features['feat'] = createFeature({
        current_phase: 'verify',
        phases_completed: ['specify', 'clarify', 'plan', 'test', 'code'],
        // verify_passed не задан — undefined
      })
      s.active_feature = 'feat'
    })

    expect(() => engine.advance())
      .toThrow('Verify не пройден')
  })
})
