/** Тип фазы в pipeline */
export interface PhaseConfig {
  name: string
  /** Фаза обязательна, нельзя пропустить */
  required?: boolean
  /** Фазу можно закрыть existing evidence (не skip, а satisfy) */
  satisfiable?: boolean
  /** Terminal action (exit), не work phase (например commit) */
  terminal?: boolean
  /** Минимальная длина satisfy_evidence для этой фазы (ужесточение отмазок) */
  satisfy_min_length?: number
}

/** Конфигурация pipeline */
export interface PipelineConfig {
  name: string
  phases: PhaseConfig[]
}

/** Полный конфиг guardian */
export interface GuardianConfig {
  pipeline: PipelineConfig
  /** Все доступные pipelines (индексированы по имени) */
  pipelines: Record<string, PipelineConfig>
}

/** Источник регистрации фичи */
export type RegistrationSource = 'discovered_from_spec' | 'registered_explicitly'

/** Информация о пропущенной фазе */
export interface SkipInfo {
  reason: string
  at: string // ISO timestamp
}

/** Информация о satisfy evidence */
export interface SatisfyInfo {
  evidence: string
  at: string // ISO timestamp
}

/** Информация о шаге в step cycling */
export interface StepInfo {
  name: string
  status: 'pending' | 'active' | 'done'
}

/** Результат отдельного agent check */
export type AgentCheckResult =
  | 'passed'
  | 'passed_with_notes'
  | 'failed'
  | { skipped: string }

/** Входные данные для verify_checklist v0.5 */
export interface VerifyCheckInput {
  code_review?: AgentCheckResult
  security_check?: AgentCheckResult
  spec_check?: AgentCheckResult
  codex_review?: AgentCheckResult
}

/** Состояние одной фичи */
export interface FeatureState {
  spec_path: string | null
  registration_source: RegistrationSource
  /** Pipeline этой фичи (default: 'stc') */
  pipeline: string
  current_phase: string
  current_step: number
  total_steps: number
  steps?: StepInfo[]
  verify_passed?: boolean
  phases_completed: string[]
  phases_skipped: Record<string, SkipInfo>
  phases_satisfied: Record<string, SatisfyInfo>
  created_at: string
  updated_at: string
}

/** Полное состояние guardian */
export interface GuardianState {
  version: number
  pipeline: string
  features: Record<string, FeatureState>
  active_feature: string | null
}

/** Structured result от verify_checklist */
export interface VerifyResult {
  ready: boolean
  missing_evidence: string[]
  failed_checks: string[]
  warnings: string[]
}

/** Событие audit log */
export interface AuditEvent {
  timestamp: string
  feature: string
  action: string
  phase?: string
  details?: Record<string, unknown>
}
