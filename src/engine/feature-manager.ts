import { readdirSync, existsSync, realpathSync } from 'fs'
import { join, basename, extname, resolve } from 'path'
import type { StateManager } from '../state/state-manager.js'
import type { AuditLogger } from '../logger/audit-logger.js'
import type { GuardianConfig, FeatureState } from '../state/types.js'

const FEATURE_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const MAX_NAME_LENGTH = 100

export interface FeatureListItem {
  name: string
  current_phase: string
  current_step: number
  total_steps: number
  spec_path: string | null
  registration_source: string
  is_active: boolean
  is_orphaned: boolean
  is_done: boolean
}

export interface FeatureListResult {
  features: FeatureListItem[]
  active_feature: string | null
}

export class FeatureManager {
  constructor(
    private stateManager: StateManager,
    private auditLogger: AuditLogger,
    private config: GuardianConfig,
    private projectDir?: string,
  ) {}

  register(name: string, specPath?: string, pipeline?: string): void {
    this.validateName(name)

    const state = this.stateManager.getState()
    if (state.features[name]) {
      throw new Error(`Фича "${name}" уже существует`)
    }

    const pipelineName = pipeline ?? this.config.pipeline.name
    const pipelineConfig = this.config.pipelines?.[pipelineName] ?? (pipelineName === this.config.pipeline.name ? this.config.pipeline : undefined)
    if (!pipelineConfig) {
      const available = this.config.pipelines ? Object.keys(this.config.pipelines).join(', ') : this.config.pipeline.name
      throw new Error(`Pipeline "${pipelineName}" не найден. Доступные: ${available}`)
    }

    const now = new Date().toISOString()
    const firstPhase = pipelineConfig.phases[0].name

    this.stateManager.updateState(s => {
      s.features[name] = {
        spec_path: specPath ?? null,
        registration_source: 'registered_explicitly',
        pipeline: pipelineName,
        current_phase: firstPhase,
        current_step: 0,
        total_steps: 0,
        phases_completed: [],
        phases_skipped: {},
        phases_satisfied: {},
        created_at: now,
        updated_at: now,
      }
      // Первая зарегистрированная фича → активная; если уже есть — не перезаписываем
      if (!s.active_feature) {
        s.active_feature = name
      }
    })

    this.auditLogger.log({
      timestamp: now,
      feature: name,
      action: 'feature_register',
      details: { registration_source: 'registered_explicitly', spec_path: specPath ?? null, pipeline: pipelineName },
    })
  }

  list(): FeatureListResult {
    const state = this.stateManager.getState()

    const features: FeatureListItem[] = Object.entries(state.features)
      .map(([name, feat]) => ({
        name,
        current_phase: feat.current_phase,
        current_step: feat.current_step,
        total_steps: feat.total_steps,
        spec_path: feat.spec_path,
        registration_source: feat.registration_source,
        is_active: name === state.active_feature,
        is_orphaned: this.isOrphaned(feat),
        is_done: feat.current_phase === 'done',
      }))

    return {
      features,
      active_feature: state.active_feature,
    }
  }

  switch(name: string): void {
    this.validateName(name)
    const state = this.stateManager.getState()

    if (!state.features[name]) {
      throw new Error(`Фича "${name}" не найдена`)
    }

    this.stateManager.updateState(s => {
      s.active_feature = name
    })

    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      feature: name,
      action: 'feature_switch',
    })
  }

  scanSpecs(specsDir: string): string[] {
    const normalizedDir = resolve(specsDir)

    // Базовая проверка через resolve (работает и для несуществующих путей)
    if (this.projectDir) {
      const normalizedProject = resolve(this.projectDir)
      if (!normalizedDir.startsWith(normalizedProject + '/') && normalizedDir !== normalizedProject) {
        throw new Error(`specs_dir выходит за пределы проекта: ${specsDir}`)
      }
    }

    if (!existsSync(normalizedDir)) {
      return []
    }

    // Дополнительная проверка через realpathSync (ловит symlinks)
    if (this.projectDir && existsSync(this.projectDir)) {
      const realDir = realpathSync(normalizedDir)
      const realProject = realpathSync(resolve(this.projectDir))
      if (!realDir.startsWith(realProject + '/') && realDir !== realProject) {
        throw new Error(`specs_dir выходит за пределы проекта: ${specsDir}`)
      }
    }

    const files = readdirSync(normalizedDir)
      .filter(f => f.endsWith('.md') && !f.startsWith('_'))

    const state = this.stateManager.getState()
    const discovered: string[] = []

    for (const file of files) {
      const name = basename(file, extname(file))
      // Пропускаем если уже отслеживается (по имени)
      if (state.features[name]) continue

      // Пропускаем нумерованные префиксы: 01-guardian-mcp.md → guardian-mcp
      const cleanName = name.replace(/^\d+-/, '')
      if (state.features[cleanName]) continue

      const featureName = cleanName

      // Валидируем имя — пропускаем файлы с невалидными именами
      try {
        this.validateName(featureName)
      } catch {
        continue
      }

      const specPath = join(normalizedDir, file)
      const now = new Date().toISOString()
      const defaultPipeline = this.config.pipeline.name
      const firstPhase = this.config.pipeline.phases[0].name

      this.stateManager.updateState(s => {
        s.features[featureName] = {
          spec_path: specPath,
          registration_source: 'discovered_from_spec',
          pipeline: defaultPipeline,
          current_phase: firstPhase,
          current_step: 0,
          total_steps: 0,
          phases_completed: [],
          phases_skipped: {},
          phases_satisfied: {},
          created_at: now,
          updated_at: now,
        }
        // Первая обнаруженная фича → активная (если нет активной)
        if (!s.active_feature) {
          s.active_feature = featureName
        }
      })

      this.auditLogger.log({
        timestamp: now,
        feature: featureName,
        action: 'feature_register',
        details: { registration_source: 'discovered_from_spec', spec_path: specPath },
      })

      discovered.push(featureName)
    }

    return discovered
  }

  private validateName(name: string): void {
    if (!name || name.length === 0) {
      throw new Error('Имя фичи не может быть пустым')
    }
    if (name.length > MAX_NAME_LENGTH) {
      throw new Error(`Имя фичи слишком длинное (макс ${MAX_NAME_LENGTH} символов)`)
    }
    if (!FEATURE_NAME_REGEX.test(name)) {
      throw new Error(`Невалидное имя фичи "${name}" — допустимы буквы, цифры, дефис, подчёркивание`)
    }
  }

  private isOrphaned(feat: FeatureState): boolean {
    if (!feat.spec_path) return false
    return !existsSync(feat.spec_path)
  }
}
