import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { StateManager } from './state-manager.js'

describe('state-manager', () => {
  let tmpDir: string
  let stcDir: string
  let manager: StateManager

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardian-state-'))
    stcDir = join(tmpDir, '.stc')
    manager = new StateManager(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // BR-4: Состояние между сессиями — создание и чтение
  it('создаёт .stc/ и state.json при первом getState', () => {
    const state = manager.getState()

    expect(existsSync(join(stcDir, 'state.json'))).toBe(true)
    expect(state.version).toBe(1)
    expect(state.pipeline).toBe('stc')
    expect(state.features).toEqual({})
    expect(state.active_feature).toBeNull()
  })

  it('читает существующий state.json', () => {
    // создаём state
    const state = manager.getState()

    // новый manager на ту же директорию = "новая сессия"
    const manager2 = new StateManager(tmpDir)
    const state2 = manager2.getState()

    expect(state2.version).toBe(state.version)
    expect(state2.pipeline).toBe('stc')
  })

  // Запись и чтение фичи
  it('сохраняет feature в state', () => {
    manager.updateState(state => {
      state.features['test-feature'] = {
        spec_path: '.claude/specs/test.md',
        registration_source: 'registered_explicitly',
        current_phase: 'specify',
        current_step: 0,
        total_steps: 0,
        phases_completed: [],
        phases_skipped: {},
        phases_satisfied: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      state.active_feature = 'test-feature'
    })

    // Перечитываем с диска
    const manager2 = new StateManager(tmpDir)
    const state = manager2.getState()

    expect(state.features['test-feature']).toBeDefined()
    expect(state.features['test-feature'].current_phase).toBe('specify')
    expect(state.active_feature).toBe('test-feature')
  })

  // V-3: Optimistic concurrency
  it('конфликт версий → ошибка', () => {
    // Оба менеджера загружают state
    const manager1 = new StateManager(tmpDir)
    const manager2 = new StateManager(tmpDir)

    manager1.getState()
    manager2.getState()

    // manager1 записывает — ok
    manager1.updateState(state => {
      state.active_feature = 'feature-a'
    })

    // manager2 пытается записать со старой версией → conflict
    expect(() => {
      manager2.updateState(state => {
        state.active_feature = 'feature-b'
      })
    }).toThrow(/conflict/i)
  })

  it('после conflict можно перечитать и записать', () => {
    const manager1 = new StateManager(tmpDir)
    const manager2 = new StateManager(tmpDir)

    manager1.getState()
    manager2.getState()

    manager1.updateState(state => {
      state.active_feature = 'feature-a'
    })

    // conflict
    expect(() => {
      manager2.updateState(state => {
        state.active_feature = 'feature-b'
      })
    }).toThrow(/conflict/i)

    // reload и записать — ok
    manager2.reload()
    manager2.updateState(state => {
      state.active_feature = 'feature-b'
    })

    const final = new StateManager(tmpDir).getState()
    expect(final.active_feature).toBe('feature-b')
  })

  // Version increment
  it('version увеличивается при каждом updateState', () => {
    manager.getState()

    manager.updateState(s => { s.active_feature = 'a' })
    expect(manager.getState().version).toBe(2)

    manager.updateState(s => { s.active_feature = 'b' })
    expect(manager.getState().version).toBe(3)
  })
})
