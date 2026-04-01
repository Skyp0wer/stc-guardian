import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { GuardianState } from './types.js'
import { GuardianStateSchema } from './schemas.js'

export class StateValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: string[],
  ) {
    super(message)
    this.name = 'StateValidationError'
  }
}

export class StateManager {
  private statePath: string
  private stcDir: string
  private cachedState: GuardianState | null = null
  private knownVersion: number = 0

  constructor(private projectDir: string) {
    this.stcDir = join(projectDir, '.stc')
    this.statePath = join(this.stcDir, 'state.json')
  }

  /** Получить текущий state (копию). Создаёт файл если не существует. */
  getState(): GuardianState {
    if (this.cachedState) {
      return structuredClone(this.cachedState)
    }

    if (!existsSync(this.statePath)) {
      const initial = this.createInitialState()
      this.writeStateToDisk(initial)
      this.cachedState = initial
      this.knownVersion = initial.version
      return structuredClone(initial)
    }

    const state = this.readFromDisk()
    this.cachedState = state
    this.knownVersion = state.version
    return structuredClone(state)
  }

  /** Обновить state через callback. Проверяет optimistic concurrency. */
  updateState(updater: (state: GuardianState) => void): void {
    // Гарантируем что state инициализирован
    if (!this.cachedState) {
      this.getState()
    }

    const currentOnDisk = this.readFromDisk()

    if (currentOnDisk.version !== this.knownVersion) {
      throw new Error(
        `State conflict: ожидалась version ${this.knownVersion}, ` +
        `на диске version ${currentOnDisk.version}. ` +
        `Вызовите reload() и попробуйте снова.`
      )
    }

    const state = structuredClone(currentOnDisk)
    updater(state)
    state.version = currentOnDisk.version + 1

    this.writeStateToDisk(state)
    this.cachedState = state
    this.knownVersion = state.version
  }

  /** Перечитать state с диска (после conflict). */
  reload(): void {
    this.cachedState = null
    this.getState()
  }

  private createInitialState(): GuardianState {
    return {
      version: 1,
      pipeline: 'stc',
      features: {},
      active_feature: null,
    }
  }

  private readFromDisk(): GuardianState {
    if (!existsSync(this.statePath)) {
      throw new Error(`state.json не найден: ${this.statePath}. Файл был удалён?`)
    }
    const raw = readFileSync(this.statePath, 'utf-8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new StateValidationError(
        `state.json содержит невалидный JSON: ${this.statePath}`,
        ['Невалидный JSON'],
      )
    }
    const result = GuardianStateSchema.safeParse(parsed)
    if (!result.success) {
      const issues = result.error.issues.map(
        i => `${i.path.join('.')}: ${i.message}`,
      )
      throw new StateValidationError(
        `state.json не прошёл валидацию (${issues.length} ошибок)`,
        issues,
      )
    }
    return result.data
  }

  private writeStateToDisk(state: GuardianState): void {
    if (!existsSync(this.stcDir)) {
      mkdirSync(this.stcDir, { recursive: true })
    }
    writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf-8')
  }
}
