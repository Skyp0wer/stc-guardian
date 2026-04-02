import { join } from 'path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { StateManager } from './state/state-manager.js'
import { AuditLogger } from './logger/audit-logger.js'
import { PhaseEngine } from './engine/phase-engine.js'
import { FeatureManager } from './engine/feature-manager.js'
import { VerifyChecker } from './engine/verify-checker.js'
import { StepManager } from './engine/step-manager.js'
import { SessionLog } from './engine/session-log.js'
import { loadConfig } from './config/config-loader.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { VerifyCheckInput } from './state/types.js'

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  }
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  }
}

function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Создаёт Guardian MCP Server с 8 tools.
 * projectDir — корень проекта (где .stc/).
 */
export function createGuardianServer(projectDir: string): McpServer {
  const config = loadConfig(projectDir)
  const stateManager = new StateManager(projectDir)
  const auditLogger = new AuditLogger(projectDir)
  const phaseEngine = new PhaseEngine(stateManager, auditLogger, config)
  const featureManager = new FeatureManager(stateManager, auditLogger, config, projectDir)
  const verifyChecker = new VerifyChecker(stateManager, config, auditLogger)
  const stepManager = new StepManager(stateManager, auditLogger)
  const sessionLog = new SessionLog(auditLogger)

  const server = new McpServer(
    { name: 'workflow-guardian', version: '1.0.0' },
  )

  // --- feature_register ---
  server.tool(
    'feature_register',
    'Зарегистрировать новую фичу для tracking',
    {
      name: z.string().describe('Имя фичи (латиница, цифры, дефис, подчёркивание)'),
      spec_path: z.string().optional().describe('Путь к спеке (относительный или абсолютный)'),
      pipeline: z.string().optional().describe('Pipeline для фичи (по умолчанию stc). Доступные: stc, scd-debate'),
    },
    async (args) => {
      try {
        featureManager.register(args.name, args.spec_path, args.pipeline)
        const status = phaseEngine.getStatus()
        return jsonResult({
          registered: args.name,
          spec_path: args.spec_path ?? null,
          current_phase: status.current_phase,
          pipeline: args.pipeline ?? config.pipeline.name,
        })
      } catch (e) {
        return errorResult(toErrorMessage(e))
      }
    },
  )

  // --- feature_scan ---
  server.tool(
    'feature_scan',
    'Сканировать .claude/specs/ и автоматически зарегистрировать найденные фичи',
    {
      specs_dir: z.string().optional().describe('Путь к директории со спеками (по умолчанию .claude/specs)'),
    },
    async (args) => {
      try {
        const specsDir = args.specs_dir ?? join(projectDir, '.claude', 'specs')
        const discovered = featureManager.scanSpecs(specsDir)
        return jsonResult({
          discovered,
          total_discovered: discovered.length,
          all_features: featureManager.list(),
        })
      } catch (e) {
        return errorResult(toErrorMessage(e))
      }
    },
  )

  // --- phase_status ---
  server.tool(
    'phase_status',
    'Текущая фаза и ОБЯЗАТЕЛЬНОЕ действие. Поле action_required содержит инструкцию — ВЫПОЛНИ её',
    async () => {
      try {
        return jsonResult(phaseEngine.getStatus())
      } catch (e) {
        return errorResult(toErrorMessage(e))
      }
    },
  )

  // --- phase_advance ---
  server.tool(
    'phase_advance',
    'Transition на следующую фазу (с проверкой правил)',
    {
      skip_reason: z.string().optional().describe('Причина пропуска фазы (для non-required фаз)'),
      satisfy_evidence: z.string().optional().describe('Evidence для satisfy (для satisfiable фаз)'),
    },
    async (args) => {
      try {
        const params = (args.skip_reason !== undefined || args.satisfy_evidence !== undefined)
          ? {
            skip_reason: args.skip_reason,
            satisfy_evidence: args.satisfy_evidence,
          }
          : undefined
        return jsonResult(phaseEngine.advance(params))
      } catch (e) {
        return errorResult(toErrorMessage(e))
      }
    },
  )

  // --- verify_checklist ---
  const agentResultSchema = z.union([
    z.object({
      status: z.enum(['passed', 'passed_with_notes', 'failed']),
      summary: z.string().min(1).describe('Краткое описание что проверялось и что найдено (мин. 20 символов)'),
    }),
    z.object({ skipped: z.string().min(1) }),
  ])

  server.tool(
    'verify_checklist',
    'Structured checklist перед commit-transition. Передайте результаты агентов с summary (code_review обязателен). НЕЛЬЗЯ просто "passed" — нужно описать что проверено.',
    {
      code_review: agentResultSchema.optional().describe('Результат code review: { status: "passed", summary: "что проверено" } | { skipped: "причина" }'),
      security_check: agentResultSchema.optional().describe('Результат security check: { status: "passed", summary: "что проверено" }'),
      spec_check: agentResultSchema.optional().describe('Результат spec check: { status: "passed", summary: "что проверено" }'),
    },
    async (args) => {
      try {
        const input = (args.code_review || args.security_check || args.spec_check)
          ? {
            code_review: args.code_review as VerifyCheckInput['code_review'],
            security_check: args.security_check as VerifyCheckInput['security_check'],
            spec_check: args.spec_check as VerifyCheckInput['spec_check'],
          }
          : undefined
        return jsonResult(verifyChecker.check(input))
      } catch (e) {
        return errorResult(toErrorMessage(e))
      }
    },
  )

  // --- step_set ---
  server.tool(
    'step_set',
    'Задать количество атомарных шагов для текущей фичи (до начала цикла)',
    {
      total_steps: z.number().int().min(1).max(100).describe('Общее количество шагов'),
      steps: z.array(z.object({ name: z.string() })).optional().describe('Именованные шаги'),
    },
    async (args) => {
      try {
        stepManager.setSteps({ total_steps: args.total_steps, steps: args.steps })
        const status = phaseEngine.getStatus()
        return jsonResult({
          total_steps: args.total_steps,
          steps_named: !!args.steps,
          feature: status.feature,
          current_phase: status.current_phase,
        })
      } catch (e) {
        return errorResult(toErrorMessage(e))
      }
    },
  )

  // --- session_log ---
  server.tool(
    'session_log',
    'Просмотр audit trail',
    {
      feature: z.string().optional().describe('Фильтр по имени фичи'),
      limit: z.number().int().min(1).max(1000).optional().describe('Максимум событий (последние N)'),
    },
    async (args) => {
      try {
        return jsonResult(sessionLog.getLog({
          feature: args.feature,
          limit: args.limit,
        }))
      } catch (e) {
        return errorResult(toErrorMessage(e))
      }
    },
  )

  // --- feature_list ---
  server.tool(
    'feature_list',
    'Список всех фич и их статусов',
    async () => {
      try {
        return jsonResult(featureManager.list())
      } catch (e) {
        return errorResult(toErrorMessage(e))
      }
    },
  )

  // --- feature_switch ---
  server.tool(
    'feature_switch',
    'Переключиться на другую фичу',
    {
      name: z.string().describe('Имя фичи для переключения'),
    },
    async (args) => {
      try {
        featureManager.switch(args.name)
        return jsonResult({ switched_to: args.name })
      } catch (e) {
        return errorResult(toErrorMessage(e))
      }
    },
  )

  return server
}
