import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { parse } from 'yaml'
import type { GuardianConfig, PipelineConfig, PhaseConfig } from '../state/types.js'

/** STC pipeline — основной цикл разработки */
const STC_PIPELINE: PipelineConfig = {
  name: 'stc',
  phases: [
    { name: 'specify', required: true },
    { name: 'clarify', required: false },
    { name: 'plan', required: false },
    { name: 'test', required: true, satisfiable: true, satisfy_min_length: 50 },
    { name: 'code', required: true },
    { name: 'verify', required: true },
    { name: 'commit', terminal: true },
  ],
}

/** Все встроенные pipelines */
const DEFAULT_PIPELINES: Record<string, PipelineConfig> = {
  'stc': STC_PIPELINE,
}

/** Дефолтный конфиг guardian (immutable в runtime через Object.freeze) */
export const DEFAULT_STC_CONFIG: GuardianConfig = Object.freeze({
  pipeline: Object.freeze({
    ...STC_PIPELINE,
    phases: Object.freeze(STC_PIPELINE.phases as PhaseConfig[]),
  }),
  pipelines: Object.freeze(
    Object.fromEntries(
      Object.entries(DEFAULT_PIPELINES).map(([k, v]) => [
        k,
        Object.freeze({ ...v, phases: Object.freeze(v.phases as PhaseConfig[]) }),
      ]),
    ),
  ),
}) as GuardianConfig

/**
 * Загружает конфиг из .stc/config.yaml в указанной директории.
 * Если файла нет — возвращает копию дефолтного STC конфига.
 */
export function loadConfig(projectDir: string): GuardianConfig {
  const configPath = join(projectDir, '.stc', 'config.yaml')

  if (!existsSync(configPath)) {
    return structuredClone(DEFAULT_STC_CONFIG) as GuardianConfig
  }

  const raw = readFileSync(configPath, 'utf-8')
  const parsed: unknown = parse(raw)

  return validateConfig(parsed)
}

function validateConfig(parsed: unknown): GuardianConfig {
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('pipeline' in parsed) ||
    !parsed.pipeline ||
    typeof parsed.pipeline !== 'object'
  ) {
    throw new Error('Невалидный config.yaml: отсутствует pipeline')
  }

  const pipeline = parsed.pipeline as Record<string, unknown>

  if (typeof pipeline.name !== 'string' || pipeline.name.length === 0) {
    throw new Error('Невалидный config.yaml: pipeline.name должен быть непустой строкой')
  }

  if (!Array.isArray(pipeline.phases) || pipeline.phases.length === 0) {
    throw new Error('Невалидный config.yaml: pipeline.phases должен быть непустым массивом')
  }

  const seenNames = new Set<string>()

  for (const phase of pipeline.phases) {
    if (typeof phase.name !== 'string' || phase.name.length === 0) {
      throw new Error('Невалидный config.yaml: фаза без name или name не строка')
    }
    if (seenNames.has(phase.name)) {
      throw new Error(`Невалидный config.yaml: дубликат фазы "${phase.name}"`)
    }
    seenNames.add(phase.name)
  }

  // Собираем pipelines: из yaml + дефолтные
  const config = parsed as GuardianConfig
  if (!config.pipelines) {
    config.pipelines = { ...DEFAULT_PIPELINES }
  }
  // Основной pipeline всегда доступен по имени
  config.pipelines[config.pipeline.name] = config.pipeline

  return config
}
