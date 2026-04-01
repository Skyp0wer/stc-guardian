import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { FeatureManager } from './feature-manager.js'
import { StateManager } from '../state/state-manager.js'
import { AuditLogger } from '../logger/audit-logger.js'
import { DEFAULT_STC_CONFIG } from '../config/config-loader.js'
import type { GuardianConfig } from '../state/types.js'

describe('feature-manager', () => {
  let tmpDir: string
  let stateManager: StateManager
  let auditLogger: AuditLogger
  let manager: FeatureManager

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardian-feat-'))
    stateManager = new StateManager(tmpDir)
    auditLogger = new AuditLogger(tmpDir)
    manager = new FeatureManager(
      stateManager,
      auditLogger,
      structuredClone(DEFAULT_STC_CONFIG) as GuardianConfig,
    )
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('register', () => {
    it('регистрирует фичу и делает её активной', () => {
      manager.register('my-feature')

      const state = stateManager.getState()
      expect(state.features['my-feature']).toBeDefined()
      expect(state.features['my-feature'].current_phase).toBe('specify')
      expect(state.features['my-feature'].registration_source).toBe('registered_explicitly')
      expect(state.active_feature).toBe('my-feature')
    })

    it('регистрация с spec_path', () => {
      manager.register('my-feature', '.claude/specs/my-feature.md')

      const state = stateManager.getState()
      expect(state.features['my-feature'].spec_path).toBe('.claude/specs/my-feature.md')
    })

    it('дубликат имени → ошибка', () => {
      manager.register('my-feature')

      expect(() => manager.register('my-feature')).toThrow(/уже существует/i)
    })

    it('невалидное имя (спецсимволы) → ошибка', () => {
      expect(() => manager.register('my feature!')).toThrow(/имя/i)
      expect(() => manager.register('../hack')).toThrow(/имя/i)
      expect(() => manager.register('')).toThrow(/имя/i)
    })

    it('слишком длинное имя → ошибка', () => {
      const longName = 'a'.repeat(101)
      expect(() => manager.register(longName)).toThrow(/имя/i)
    })

    it('логирует регистрацию в audit log', () => {
      manager.register('my-feature')

      const events = auditLogger.getEvents()
      expect(events).toHaveLength(1)
      expect(events[0].action).toBe('feature_register')
      expect(events[0].feature).toBe('my-feature')
    })
  })

  // HP-3: Multi-feature
  describe('list', () => {
    it('возвращает список всех фич с их фазами', () => {
      manager.register('feat-a')
      manager.register('feat-b')
      manager.register('feat-c')

      const list = manager.list()

      expect(list.features).toHaveLength(3)
      expect(list.active_feature).toBe('feat-a') // первая зарегистрированная
      expect(list.features.map(f => f.name)).toEqual(['feat-a', 'feat-b', 'feat-c'])
      expect(list.features.every(f => f.current_phase === 'specify')).toBe(true)
    })

    it('пустой список если нет фич', () => {
      const list = manager.list()

      expect(list.features).toHaveLength(0)
      expect(list.active_feature).toBeNull()
    })

    it('активная фича помечена', () => {
      manager.register('feat-a')
      manager.register('feat-b')

      const list = manager.list()
      const active = list.features.find(f => f.is_active)

      expect(active).toBeDefined()
      expect(active!.name).toBe('feat-a') // первая зарегистрированная
    })
  })

  // HP-4: Переключение фичи
  describe('switch', () => {
    it('переключает активную фичу', () => {
      manager.register('feat-a')
      manager.register('feat-b')

      manager.switch('feat-a')

      const state = stateManager.getState()
      expect(state.active_feature).toBe('feat-a')
    })

    it('статус предыдущей фичи сохранён', () => {
      manager.register('feat-a')
      manager.register('feat-b')

      // feat-b активна, проверяем что feat-a сохранена
      manager.switch('feat-a')
      const state = stateManager.getState()
      expect(state.features['feat-b']).toBeDefined()
      expect(state.features['feat-b'].current_phase).toBe('specify')
    })

    it('несуществующая фича → ошибка', () => {
      expect(() => manager.switch('ghost')).toThrow(/не найдена/i)
    })

    it('логирует переключение', () => {
      manager.register('feat-a')
      manager.register('feat-b')
      manager.switch('feat-a')

      const events = auditLogger.getEvents({ feature: 'feat-a' })
      const switchEvent = events.find(e => e.action === 'feature_switch')
      expect(switchEvent).toBeDefined()
    })
  })

  // BR-3: Автоматический старт tracking (STC adapter)
  describe('scanSpecs', () => {
    it('находит новые спеки и создаёт tracking', () => {
      const specsDir = join(tmpDir, '.claude', 'specs')
      mkdirSync(specsDir, { recursive: true })
      writeFileSync(join(specsDir, 'auth-system.md'), '# SPEC: Auth System')
      writeFileSync(join(specsDir, 'payments.md'), '# SPEC: Payments')

      const discovered = manager.scanSpecs(specsDir)

      expect(discovered).toHaveLength(2)

      const state = stateManager.getState()
      expect(state.features['auth-system']).toBeDefined()
      expect(state.features['auth-system'].registration_source).toBe('discovered_from_spec')
      expect(state.features['auth-system'].spec_path).toBe(join(specsDir, 'auth-system.md'))
      expect(state.features['payments']).toBeDefined()
    })

    it('не создаёт дубликаты для уже трекаемых фич', () => {
      const specsDir = join(tmpDir, '.claude', 'specs')
      mkdirSync(specsDir, { recursive: true })
      writeFileSync(join(specsDir, 'my-feature.md'), '# SPEC')

      manager.scanSpecs(specsDir) // первый скан
      manager.scanSpecs(specsDir) // повторный скан

      const state = stateManager.getState()
      expect(Object.keys(state.features)).toHaveLength(1)
    })

    it('игнорирует файлы с _ префиксом (шаблоны)', () => {
      const specsDir = join(tmpDir, '.claude', 'specs')
      mkdirSync(specsDir, { recursive: true })
      writeFileSync(join(specsDir, '_template.md'), '# Template')
      writeFileSync(join(specsDir, 'real-feature.md'), '# SPEC')

      manager.scanSpecs(specsDir)

      const state = stateManager.getState()
      expect(Object.keys(state.features)).toHaveLength(1)
      expect(state.features['real-feature']).toBeDefined()
    })

    it('strip нумерованного префикса: 01-guardian-mcp.md → guardian-mcp', () => {
      const specsDir = join(tmpDir, '.claude', 'specs')
      mkdirSync(specsDir, { recursive: true })
      writeFileSync(join(specsDir, '01-guardian-mcp.md'), '# SPEC')
      writeFileSync(join(specsDir, '02-auth.md'), '# SPEC')

      manager.scanSpecs(specsDir)

      const state = stateManager.getState()
      expect(state.features['guardian-mcp']).toBeDefined()
      expect(state.features['auth']).toBeDefined()
      expect(state.features['01-guardian-mcp']).toBeUndefined()
    })

    it('несуществующая директория → пустой массив', () => {
      const result = manager.scanSpecs(join(tmpDir, 'nonexistent'))
      expect(result).toEqual([])
    })

    it('первая обнаруженная фича становится активной если нет активной', () => {
      const specsDir = join(tmpDir, '.claude', 'specs')
      mkdirSync(specsDir, { recursive: true })
      writeFileSync(join(specsDir, 'new-feature.md'), '# SPEC')

      manager.scanSpecs(specsDir)

      const state = stateManager.getState()
      expect(state.active_feature).toBe('new-feature')
    })
  })

  // EC-1: Удалённая спека
  describe('orphaned detection', () => {
    it('list помечает фичу как orphaned если спека удалена', () => {
      const specsDir = join(tmpDir, '.claude', 'specs')
      mkdirSync(specsDir, { recursive: true })
      writeFileSync(join(specsDir, 'temp-feature.md'), '# SPEC')

      manager.scanSpecs(specsDir)

      // Удаляем спеку
      rmSync(join(specsDir, 'temp-feature.md'))

      const list = manager.list()
      const feat = list.features.find(f => f.name === 'temp-feature')

      expect(feat).toBeDefined()
      expect(feat!.is_orphaned).toBe(true)
    })

    it('фича без spec_path — не orphaned', () => {
      manager.register('no-spec-feature')

      const list = manager.list()
      const feat = list.features.find(f => f.name === 'no-spec-feature')

      expect(feat!.is_orphaned).toBe(false)
    })
  })
})
