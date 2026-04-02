import type { StateManager } from '../state/state-manager.js'
import type { AuditLogger } from '../logger/audit-logger.js'
import type { GuardianConfig, VerifyResult, VerifyCheckInput, AgentCheckResult } from '../state/types.js'

/** Минимальная длина summary для agent result (анти-враньё) */
const MIN_SUMMARY_LENGTH = 20

/** Минимум секунд между code→verify и verify_checklist (анти-спидран) */
const MIN_VERIFY_DELAY_SEC = 30

/**
 * Structured verify checklist перед commit-transition.
 * v1.1: summary обязателен, таймстамп проверка, анти-враньё.
 */
export class VerifyChecker {
  constructor(
    private stateManager: StateManager,
    private config: GuardianConfig,
    private auditLogger?: AuditLogger,
  ) {}

  check(input?: VerifyCheckInput): VerifyResult {
    const state = this.stateManager.getState()

    if (!state.active_feature) {
      throw new Error('Нет активной фичи — нечего проверять')
    }

    const featureName = state.active_feature
    const feature = state.features[featureName]
    if (!feature) {
      throw new Error(`Фича "${featureName}" не найдена в state`)
    }

    const missing: string[] = []
    const failed: string[] = []
    const warnings: string[] = []

    // === A: Таймстамп проверка (анти-спидран) ===
    if (feature.code_completed_at) {
      const codeCompletedAt = new Date(feature.code_completed_at).getTime()
      const now = Date.now()
      const elapsedSec = (now - codeCompletedAt) / 1000

      if (elapsedSec < MIN_VERIFY_DELAY_SEC) {
        warnings.push(
          `ПОДОЗРИТЕЛЬНО: verify_checklist через ${Math.round(elapsedSec)}с после code→verify. ` +
          `Минимум ${MIN_VERIFY_DELAY_SEC}с нужно для реального ревью. Если ревью было до phase_advance — ок.`,
        )
      }
    }

    // === B: Agent results с обязательным summary ===
    if (!input || !input.code_review) {
      missing.push('code_review не предоставлен — запусти @code-reviewer')
    } else {
      this.checkAgent('code_review', input.code_review, failed, warnings)
    }

    if (!input || !input.security_check) {
      missing.push('security_check не предоставлен — запусти @security-guard')
    } else {
      this.checkAgent('security_check', input.security_check, failed, warnings)
    }

    if (input?.spec_check) {
      this.checkAgent('spec_check', input.spec_check, failed, warnings)
    }

    const ready = missing.length === 0 && failed.length === 0

    // Set verify_passed в state
    this.stateManager.updateState(s => {
      const f = s.features[featureName]
      f.verify_passed = ready
      f.updated_at = new Date().toISOString()
    })

    // Audit log
    if (this.auditLogger) {
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        feature: featureName,
        action: 'verify_check',
        details: {
          ready,
          missing_evidence: missing,
          failed_checks: failed,
          warnings,
        },
      })
    }

    return {
      ready,
      missing_evidence: missing,
      failed_checks: failed,
      warnings,
    }
  }

  private checkAgent(
    name: string,
    result: AgentCheckResult,
    failed: string[],
    warnings: string[],
  ): void {
    // Skipped
    if ('skipped' in result) {
      if (!result.skipped || result.skipped.length === 0) {
        failed.push(`${name}: skip без причины`)
      } else {
        warnings.push(`${name} skipped: ${result.skipped}`)
      }
      return
    }

    // v1.1: summary обязателен
    if (!('summary' in result) || !result.summary) {
      failed.push(`${name}: summary обязателен — опиши что проверялось и что найдено`)
      return
    }

    if (result.summary.length < MIN_SUMMARY_LENGTH) {
      failed.push(
        `${name}: summary слишком короткий (${result.summary.length} символов, мин. ${MIN_SUMMARY_LENGTH}). ` +
        `Опиши что проверялось и результат.`,
      )
      return
    }

    switch (result.status) {
      case 'passed':
        break
      case 'passed_with_notes':
        warnings.push(`${name}: passed with notes — ${result.summary}`)
        break
      case 'failed':
        failed.push(`${name}: failed — ${result.summary}`)
        break
    }
  }
}
