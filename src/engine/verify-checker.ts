import type { StateManager } from '../state/state-manager.js'
import type { AuditLogger } from '../logger/audit-logger.js'
import type { GuardianConfig, VerifyResult, VerifyCheckInput, AgentCheckResult } from '../state/types.js'

/**
 * Structured verify checklist перед commit-transition.
 * v0.5: agent results + hard gate (sets verify_passed).
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

    // Agent results check (v0.5)
    if (!input || !input.code_review) {
      missing.push('code_review не предоставлен')
    } else {
      this.checkAgent('code_review', input.code_review, failed, warnings)
    }

    if (input?.security_check) {
      this.checkAgent('security_check', input.security_check, failed, warnings)
    }

    if (input?.spec_check) {
      this.checkAgent('spec_check', input.spec_check, failed, warnings)
    }

    if (input?.codex_review) {
      this.checkAgent('codex_review', input.codex_review, failed, warnings)
    }

    const ready = missing.length === 0 && failed.length === 0

    // Set verify_passed в state
    this.stateManager.updateState(s => {
      const f = s.features[featureName]
      f.verify_passed = ready
      f.updated_at = new Date().toISOString()
    })

    // Audit log (v0.5)
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
    if (typeof result === 'object' && 'skipped' in result) {
      if (!result.skipped || result.skipped.length === 0) {
        failed.push(`${name}: skip без причины`)
      } else {
        warnings.push(`${name} skipped: ${result.skipped}`)
      }
      return
    }

    switch (result) {
      case 'passed':
        break
      case 'passed_with_notes':
        warnings.push(`${name}: passed with notes`)
        break
      case 'failed':
        failed.push(`${name}: failed`)
        break
    }
  }
}
