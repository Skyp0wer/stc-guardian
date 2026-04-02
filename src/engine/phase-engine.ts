import type { StateManager } from '../state/state-manager.js'
import type { AuditLogger } from '../logger/audit-logger.js'
import type { GuardianConfig, PhaseConfig, FeatureState } from '../state/types.js'

export interface StepDisplayInfo {
  name: string
  display: string // "Шаг 3/5: step name"
}

export interface PhaseStatusResult {
  feature: string
  current_phase: string
  current_step: number
  total_steps: number
  step_info?: StepDisplayInfo
  verify_passed: boolean
  next_phase: string | null
  phases_completed: string[]
  phases_skipped: string[]
  phases_satisfied: string[]
  is_done: boolean
  action_required: string | null
}

export interface AdvanceParams {
  skip_reason?: string
  satisfy_evidence?: string
}

export interface AdvanceResult {
  previous_phase: string
  current_phase: string | null
  action: 'completed' | 'skipped' | 'satisfied'
  is_done: boolean
}

export class PhaseEngine {
  constructor(
    private stateManager: StateManager,
    private auditLogger: AuditLogger,
    private config: GuardianConfig,
  ) {}

  /** Получить фазы pipeline для конкретной фичи */
  private getPhasesForFeature(feature: FeatureState): PhaseConfig[] {
    const pipelineName = feature.pipeline ?? this.config.pipeline.name
    const pipelineConfig = this.config.pipelines?.[pipelineName]
    if (!pipelineConfig) {
      // fallback на дефолтный pipeline (для обратной совместимости)
      return this.config.pipeline.phases
    }
    return pipelineConfig.phases
  }

  getStatus(): PhaseStatusResult {
    const state = this.stateManager.getState()
    const { featureName, feature } = this.getActiveFeature(state)

    const phases = this.getPhasesForFeature(feature)
    const nextPhase = this.getNextPhaseFromList(phases, feature.current_phase)

    let stepInfo: StepDisplayInfo | undefined
    if (feature.steps && feature.steps.length > 0 && feature.current_step < feature.steps.length) {
      const step = feature.steps[feature.current_step]
      stepInfo = {
        name: step.name,
        display: `Шаг ${feature.current_step + 1}/${feature.total_steps}: ${step.name}`,
      }
    }

    return {
      feature: featureName,
      current_phase: feature.current_phase,
      current_step: feature.current_step,
      total_steps: feature.total_steps,
      step_info: stepInfo,
      verify_passed: feature.verify_passed ?? false,
      next_phase: nextPhase,
      phases_completed: [...feature.phases_completed],
      phases_skipped: Object.keys(feature.phases_skipped),
      phases_satisfied: Object.keys(feature.phases_satisfied),
      is_done: feature.current_phase === 'done',
      action_required: this.getActionRequired(feature.current_phase, feature.verify_passed ?? false),
    }
  }

  advance(params?: AdvanceParams): AdvanceResult {
    const state = this.stateManager.getState()
    const { featureName, feature } = this.getActiveFeature(state)
    const currentPhase = feature.current_phase

    if (currentPhase === 'done') {
      throw new Error(`Фича "${featureName}" уже завершена (done)`)
    }

    const phases = this.getPhasesForFeature(feature)
    const phaseConfig = this.findPhaseInList(phases, currentPhase, feature.pipeline ?? this.config.pipeline.name)
    const isSkip = params?.skip_reason !== undefined
    const isSatisfy = params?.satisfy_evidence !== undefined

    const MAX_TEXT_LENGTH = 2000

    // Валидация: skip и satisfy взаимоисключающие
    if (isSkip && isSatisfy) {
      throw new Error('Нельзя указать skip_reason и satisfy_evidence одновременно')
    }

    if (isSkip) {
      if (params.skip_reason!.length === 0) {
        throw new Error('skip_reason не может быть пустым — укажите причину пропуска')
      }
      if (params.skip_reason!.length > MAX_TEXT_LENGTH) {
        throw new Error(`skip_reason слишком длинный (макс ${MAX_TEXT_LENGTH} символов)`)
      }
      if (phaseConfig.required) {
        throw new Error(`Фаза "${currentPhase}" обязательна (required), skip невозможен`)
      }
    }

    if (isSatisfy) {
      if (params.satisfy_evidence!.length === 0) {
        throw new Error('satisfy_evidence не может быть пустым — укажите evidence')
      }
      if (params.satisfy_evidence!.length > MAX_TEXT_LENGTH) {
        throw new Error(`satisfy_evidence слишком длинный (макс ${MAX_TEXT_LENGTH} символов)`)
      }
      if (!phaseConfig.satisfiable) {
        throw new Error(`Фаза "${currentPhase}" не поддерживает satisfy — только обычный advance`)
      }
      // Минимальная длина satisfy_evidence для guarded фаз (test)
      if (phaseConfig.satisfy_min_length && params.satisfy_evidence!.length < phaseConfig.satisfy_min_length) {
        throw new Error(
          `Фаза "${currentPhase}" требует подробное satisfy_evidence ` +
          `(мин. ${phaseConfig.satisfy_min_length} символов, сейчас ${params.satisfy_evidence!.length}). ` +
          `Перечислите изменённые файлы и обоснуйте почему тесты не нужны.`,
        )
      }
    }

    // Hard verify gate (v0.5): verify фаза требует verify_passed = true
    if (currentPhase === 'verify' && !isSkip && !isSatisfy) {
      if (!(feature.verify_passed ?? false)) {
        throw new Error('Verify не пройден. Вызовите verify_checklist сначала')
      }
    }

    // Определяем action
    let action: AdvanceResult['action'] = 'completed'
    if (isSkip) action = 'skipped'
    else if (isSatisfy) action = 'satisfied'

    // Определяем следующую фазу
    const isTerminal = phaseConfig.terminal === true
    const nextPhase = isTerminal ? null : this.getNextPhaseFromList(phases, currentPhase)

    // Step cycling (v0.5): commit с шагами → reset на test
    const hasSteps = feature.total_steps > 0
    const isLastStep = !hasSteps || feature.current_step >= feature.total_steps - 1
    const shouldCycle = isTerminal && hasSteps && !isLastStep
    const newStep = shouldCycle ? feature.current_step + 1 : feature.current_step

    let newCurrentPhase: string
    if (shouldCycle) {
      // Находим фазу test для reset
      const testPhase = phases.find(p => p.name === 'test')
      newCurrentPhase = testPhase ? testPhase.name : (nextPhase ?? 'done')
    } else {
      newCurrentPhase = nextPhase ?? 'done'
    }
    const isDone = newCurrentPhase === 'done'

    // Обновляем state
    const now = new Date().toISOString()
    this.stateManager.updateState(s => {
      const f = s.features[featureName]
      f.phases_completed.push(currentPhase)

      // Записываем timestamp code→verify для anti-speedrun проверки
      if (currentPhase === 'code') {
        f.code_completed_at = now
      }

      if (isSkip) {
        f.phases_skipped[currentPhase] = { reason: params!.skip_reason!, at: now }
      }
      if (isSatisfy) {
        f.phases_satisfied[currentPhase] = { evidence: params!.satisfy_evidence!, at: now }
      }

      // Step cycling: advance step + reset
      if (shouldCycle) {
        const prevStep = f.current_step
        f.current_step = prevStep + 1
        if (f.steps) {
          if (f.steps[prevStep]) f.steps[prevStep].status = 'done'
          if (f.steps[f.current_step]) f.steps[f.current_step].status = 'active'
        }
        f.verify_passed = false // reset verify для нового шага
      }

      f.current_phase = newCurrentPhase
      f.updated_at = now
    })

    // Логируем
    const auditAction = isSkip ? 'phase_skip' : isSatisfy ? 'phase_satisfy' : 'phase_advance'
    this.auditLogger.log({
      timestamp: now,
      feature: featureName,
      action: auditAction,
      phase: currentPhase,
      details: {
        next_phase: shouldCycle ? newCurrentPhase : nextPhase,
        is_done: isDone,
        ...(isSkip && { reason: params!.skip_reason }),
        ...(isSatisfy && { evidence: params!.satisfy_evidence }),
        ...(shouldCycle && { step_cycle: true, new_step: newStep }),
      },
    })

    return {
      previous_phase: currentPhase,
      current_phase: shouldCycle ? newCurrentPhase : nextPhase,
      action,
      is_done: isDone,
    }
  }

  private getActiveFeature(state: ReturnType<StateManager['getState']>) {
    if (!state.active_feature) {
      throw new Error('Нет активной фичи — сначала зарегистрируйте или переключитесь на фичу')
    }
    const feature = state.features[state.active_feature]
    if (!feature) {
      throw new Error(`Фича "${state.active_feature}" не найдена в state`)
    }
    return { featureName: state.active_feature, feature }
  }

  private findPhaseInList(phases: PhaseConfig[], phaseName: string, pipelineName: string): PhaseConfig {
    const phase = phases.find(p => p.name === phaseName)
    if (!phase) {
      throw new Error(`Фаза "${phaseName}" не найдена в pipeline "${pipelineName}"`)
    }
    return phase
  }

  private getActionRequired(phase: string, verifyPassed: boolean): string | null {
    const actions: Record<string, string> = {
      // STC pipeline
      specify: 'ДЕЙСТВИЕ: Напиши спеку → phase_advance',
      clarify: 'ДЕЙСТВИЕ: Задай вопросы по спеке или phase_advance (skip_reason если не нужен)',
      plan: 'ДЕЙСТВИЕ: Разбей на атомарные шаги → phase_advance',
      test: 'ДЕЙСТВИЕ: НАПИШИ ТЕСТЫ для бизнес-логики этого шага → phase_advance. Skip ЗАПРЕЩЁН. Если тестировать НЕЧЕГО — satisfy_evidence с перечислением изменённых файлов и обоснованием (конфиг, типы, README).',
      code: 'ДЕЙСТВИЕ: Напиши код → phase_advance. НЕ КОММИТЬ без прохождения verify!',
      verify: verifyPassed
        ? 'ДЕЙСТВИЕ: Verify пройден → phase_advance'
        : 'ДЕЙСТВИЕ: Запусти ПАРАЛЛЕЛЬНО: @code-reviewer + @security-guard → verify_checklist с результатами → phase_advance',
      commit: 'ДЕЙСТВИЕ: git commit → phase_advance',
    }
    return actions[phase] ?? null
  }

  private getNextPhaseFromList(phases: PhaseConfig[], currentPhaseName: string): string | null {
    const idx = phases.findIndex(p => p.name === currentPhaseName)
    if (idx === -1 || idx >= phases.length - 1) {
      return null
    }
    return phases[idx + 1].name
  }
}
