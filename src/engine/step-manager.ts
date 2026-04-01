import type { StateManager } from '../state/state-manager.js'
import type { AuditLogger } from '../logger/audit-logger.js'
import type { StepInfo } from '../state/types.js'

export interface SetStepsParams {
  total_steps: number
  steps?: { name: string }[]
}

export class StepManager {
  constructor(
    private stateManager: StateManager,
    private auditLogger: AuditLogger,
  ) {}

  setSteps(params: SetStepsParams): void {
    const state = this.stateManager.getState()

    if (!state.active_feature) {
      throw new Error('Нет активной фичи — сначала зарегистрируйте или переключитесь на фичу')
    }

    const feature = state.features[state.active_feature]
    if (!feature) {
      throw new Error(`Фича "${state.active_feature}" не найдена в state`)
    }

    if (feature.current_step > 0) {
      throw new Error('Нельзя менять шаги после начала цикла')
    }

    if (params.total_steps < 1) {
      throw new Error('total_steps должен быть >= 1')
    }

    if (params.steps && params.steps.length !== params.total_steps) {
      throw new Error(
        `Количество шагов (${params.steps.length}) не совпадает с total_steps (${params.total_steps})`,
      )
    }

    const featureName = state.active_feature
    const steps: StepInfo[] | undefined = params.steps
      ? params.steps.map((s, i) => ({
          name: s.name,
          status: i === 0 ? 'active' as const : 'pending' as const,
        }))
      : undefined

    const now = new Date().toISOString()
    this.stateManager.updateState(s => {
      const f = s.features[featureName]
      f.total_steps = params.total_steps
      f.steps = steps
      f.updated_at = now
    })

    this.auditLogger.log({
      timestamp: now,
      feature: featureName,
      action: 'step_set',
      details: {
        total_steps: params.total_steps,
        steps_named: !!params.steps,
      },
    })
  }
}
