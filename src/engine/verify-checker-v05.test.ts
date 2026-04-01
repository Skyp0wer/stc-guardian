import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { VerifyChecker } from './verify-checker.js'
import { StateManager } from '../state/state-manager.js'
import { DEFAULT_STC_CONFIG } from '../config/config-loader.js'
import type { FeatureState } from '../state/types.js'

function createFeature(overrides?: Partial<FeatureState>): FeatureState {
  return {
    spec_path: null,
    registration_source: 'registered_explicitly',
    current_phase: 'verify',
    current_step: 0,
    total_steps: 0,
    phases_completed: ['specify', 'clarify', 'plan', 'test', 'code'],
    phases_skipped: {},
    phases_satisfied: {},
    created_at: '2026-03-10T12:00:00Z',
    updated_at: '2026-03-10T12:00:00Z',
    ...overrides,
  }
}

function setup() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'guardian-verify-'))
  mkdirSync(join(tmpDir, '.stc'), { recursive: true })
  const stateManager = new StateManager(tmpDir)
  const checker = new VerifyChecker(stateManager, DEFAULT_STC_CONFIG)
  return { stateManager, checker, tmpDir }
}

describe('v0.5: verify_checklist с agent results', () => {
  // TS-6: все passed
  it('все агенты passed → verify_passed = true (TS-6)', () => {
    const { stateManager, checker } = setup()
    stateManager.updateState(s => {
      s.features['feat'] = createFeature()
      s.active_feature = 'feat'
    })

    const result = checker.check({
      code_review: 'passed',
      security_check: 'passed',
      spec_check: 'passed',
    })

    expect(result.ready).toBe(true)
    expect(result.missing_evidence).toHaveLength(0)
    expect(result.failed_checks).toHaveLength(0)

    const state = stateManager.getState()
    expect(state.features['feat'].verify_passed).toBe(true)
  })

  // TS-7: code_review failed
  it('code_review failed → verify_passed = false (TS-7)', () => {
    const { stateManager, checker } = setup()
    stateManager.updateState(s => {
      s.features['feat'] = createFeature()
      s.active_feature = 'feat'
    })

    const result = checker.check({
      code_review: 'failed',
    })

    expect(result.ready).toBe(false)
    expect(result.failed_checks).toContain('code_review: failed')

    const state = stateManager.getState()
    expect(state.features['feat'].verify_passed).toBe(false)
  })

  // TS-8: без аргументов
  it('без аргументов → incomplete (TS-8)', () => {
    const { stateManager, checker } = setup()
    stateManager.updateState(s => {
      s.features['feat'] = createFeature()
      s.active_feature = 'feat'
    })

    const result = checker.check()

    expect(result.ready).toBe(false)
    expect(result.missing_evidence).toContain('code_review не предоставлен')

    const state = stateManager.getState()
    expect(state.features['feat'].verify_passed).toBe(false)
  })

  // TS-14: security skip с причиной
  it('security skip с причиной → passed (TS-14)', () => {
    const { stateManager, checker } = setup()
    stateManager.updateState(s => {
      s.features['feat'] = createFeature()
      s.active_feature = 'feat'
    })

    const result = checker.check({
      code_review: 'passed',
      security_check: { skipped: 'no deps changed' },
      spec_check: 'passed',
    })

    expect(result.ready).toBe(true)
    expect(result.warnings).toContain('security_check skipped: no deps changed')

    const state = stateManager.getState()
    expect(state.features['feat'].verify_passed).toBe(true)
  })

  it('passed_with_notes → считается passed', () => {
    const { stateManager, checker } = setup()
    stateManager.updateState(s => {
      s.features['feat'] = createFeature()
      s.active_feature = 'feat'
    })

    const result = checker.check({
      code_review: 'passed_with_notes',
      security_check: 'passed_with_notes',
      spec_check: 'passed_with_notes',
    })

    expect(result.ready).toBe(true)
    expect(result.warnings).toHaveLength(3) // notes — warnings
  })

  it('spec_check skip без причины → ошибка', () => {
    const { stateManager, checker } = setup()
    stateManager.updateState(s => {
      s.features['feat'] = createFeature()
      s.active_feature = 'feat'
    })

    const result = checker.check({
      code_review: 'passed',
      spec_check: { skipped: '' },
    })

    expect(result.ready).toBe(false)
    expect(result.failed_checks).toContain('spec_check: skip без причины')
  })
})
