import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createGuardianServer } from './server.js'

async function setupServer(projectDir: string) {
  const server = createGuardianServer(projectDir)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  await server.connect(serverTransport)

  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)

  return { server, client }
}

describe('guardian MCP server', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardian-mcp-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('регистрирует 9 tools', async () => {
    const { client } = await setupServer(tmpDir)

    const { tools } = await client.listTools()

    expect(tools).toHaveLength(9)
    const names = tools.map(t => t.name).sort()
    expect(names).toEqual([
      'feature_list',
      'feature_register',
      'feature_scan',
      'feature_switch',
      'phase_advance',
      'phase_status',
      'session_log',
      'step_set',
      'verify_checklist',
    ])
  })

  // HP-1 E2E: полный цикл через MCP tools
  it('HP-1: полный цикл фичи через MCP', async () => {
    const { client } = await setupServer(tmpDir)

    // Регистрируем фичу через phase_status (автоматически нет фичи → нужна регистрация)
    // Сначала feature_list — пустой
    let result = await client.callTool({ name: 'feature_list', arguments: {} })
    let parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(parsed.features).toHaveLength(0)

    // phase_status без активной фичи → ошибка
    result = await client.callTool({ name: 'phase_status', arguments: {} })
    expect(result.isError).toBe(true)

    // Регистрируем через feature_switch (сначала нужно зарегистрировать)
    // Используем phase_advance — нет фичи → ошибка
    result = await client.callTool({ name: 'phase_advance', arguments: {} })
    expect(result.isError).toBe(true)
  })

  it('phase_status возвращает статус активной фичи', async () => {
    const { StateManager } = await import('./state/state-manager.js')
    const sm = new StateManager(tmpDir)
    sm.updateState(s => {
      s.features['test-feat'] = {
        spec_path: null,
        registration_source: 'registered_explicitly',
        current_phase: 'code',
        current_step: 3,
        total_steps: 5,
        phases_completed: ['specify', 'clarify', 'plan', 'test'],
        phases_skipped: {},
        phases_satisfied: {},
        created_at: '2026-03-10T12:00:00Z',
        updated_at: '2026-03-10T12:00:00Z',
      }
      s.active_feature = 'test-feat'
    })

    const setup = await setupServer(tmpDir)
    const result = await setup.client.callTool({ name: 'phase_status', arguments: {} })
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)

    expect(parsed.feature).toBe('test-feat')
    expect(parsed.current_phase).toBe('code')
    expect(parsed.next_phase).toBe('verify')
  })

  it('phase_advance: transition specify → clarify', async () => {
    const { StateManager } = await import('./state/state-manager.js')
    const sm = new StateManager(tmpDir)
    sm.updateState(s => {
      s.features['my-feat'] = {
        spec_path: null,
        registration_source: 'registered_explicitly',
        current_phase: 'specify',
        current_step: 0,
        total_steps: 0,
        phases_completed: [],
        phases_skipped: {},
        phases_satisfied: {},
        created_at: '2026-03-10T12:00:00Z',
        updated_at: '2026-03-10T12:00:00Z',
      }
      s.active_feature = 'my-feat'
    })

    const { client } = await setupServer(tmpDir)
    const result = await client.callTool({ name: 'phase_advance', arguments: {} })
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)

    expect(parsed.previous_phase).toBe('specify')
    expect(parsed.current_phase).toBe('clarify')
    expect(parsed.action).toBe('completed')
  })

  it('phase_advance с skip_reason', async () => {
    const { StateManager } = await import('./state/state-manager.js')
    const sm = new StateManager(tmpDir)
    sm.updateState(s => {
      s.features['my-feat'] = {
        spec_path: null,
        registration_source: 'registered_explicitly',
        current_phase: 'clarify',
        current_step: 0,
        total_steps: 0,
        phases_completed: ['specify'],
        phases_skipped: {},
        phases_satisfied: {},
        created_at: '2026-03-10T12:00:00Z',
        updated_at: '2026-03-10T12:00:00Z',
      }
      s.active_feature = 'my-feat'
    })

    const { client } = await setupServer(tmpDir)
    const result = await client.callTool({
      name: 'phase_advance',
      arguments: { skip_reason: 'Clarify не нужен — спека полностью описывает задачу, вопросов нет' },
    })
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)

    expect(parsed.action).toBe('skipped')
    expect(parsed.current_phase).toBe('plan')
  })

  it('verify_checklist: ready когда agent results passed', async () => {
    const { StateManager } = await import('./state/state-manager.js')
    const sm = new StateManager(tmpDir)
    sm.updateState(s => {
      s.features['my-feat'] = {
        spec_path: null,
        registration_source: 'registered_explicitly',
        current_phase: 'verify',
        current_step: 0,
        total_steps: 0,
        phases_completed: ['specify', 'clarify', 'plan', 'test', 'code'],
        phases_skipped: {},
        phases_satisfied: {},
        created_at: '2026-03-10T12:00:00Z',
        updated_at: '2026-03-10T12:00:00Z',
      }
      s.active_feature = 'my-feat'
    })

    const { client } = await setupServer(tmpDir)
    const result = await client.callTool({
      name: 'verify_checklist',
      arguments: { code_review: { status: 'passed', summary: 'Проверено 5 файлов, багов не найдено' }, security_check: { status: 'passed', summary: 'Секретов не найдено, deps чистые' } },
    })
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)

    expect(parsed.ready).toBe(true)
    expect(parsed.missing_evidence).toHaveLength(0)
  })

  it('feature_list: возвращает список фич', async () => {
    const { StateManager } = await import('./state/state-manager.js')
    const sm = new StateManager(tmpDir)
    sm.updateState(s => {
      s.features['feat-a'] = {
        spec_path: null,
        registration_source: 'registered_explicitly',
        current_phase: 'code',
        current_step: 0,
        total_steps: 0,
        phases_completed: [],
        phases_skipped: {},
        phases_satisfied: {},
        created_at: '2026-03-10T12:00:00Z',
        updated_at: '2026-03-10T12:00:00Z',
      }
      s.features['feat-b'] = {
        spec_path: null,
        registration_source: 'registered_explicitly',
        current_phase: 'test',
        current_step: 0,
        total_steps: 0,
        phases_completed: [],
        phases_skipped: {},
        phases_satisfied: {},
        created_at: '2026-03-10T12:00:00Z',
        updated_at: '2026-03-10T12:00:00Z',
      }
      s.active_feature = 'feat-a'
    })

    const { client } = await setupServer(tmpDir)
    const result = await client.callTool({ name: 'feature_list', arguments: {} })
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)

    expect(parsed.features).toHaveLength(2)
    expect(parsed.active_feature).toBe('feat-a')
  })

  it('feature_switch: переключает фичу', async () => {
    const { StateManager } = await import('./state/state-manager.js')
    const sm = new StateManager(tmpDir)
    sm.updateState(s => {
      s.features['feat-a'] = {
        spec_path: null,
        registration_source: 'registered_explicitly',
        current_phase: 'code',
        current_step: 0,
        total_steps: 0,
        phases_completed: [],
        phases_skipped: {},
        phases_satisfied: {},
        created_at: '2026-03-10T12:00:00Z',
        updated_at: '2026-03-10T12:00:00Z',
      }
      s.features['feat-b'] = {
        spec_path: null,
        registration_source: 'registered_explicitly',
        current_phase: 'test',
        current_step: 0,
        total_steps: 0,
        phases_completed: [],
        phases_skipped: {},
        phases_satisfied: {},
        created_at: '2026-03-10T12:00:00Z',
        updated_at: '2026-03-10T12:00:00Z',
      }
      s.active_feature = 'feat-a'
    })

    const { client } = await setupServer(tmpDir)
    const result = await client.callTool({
      name: 'feature_switch',
      arguments: { name: 'feat-b' },
    })
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)

    expect(parsed.switched_to).toBe('feat-b')
  })

  it('session_log: возвращает audit trail', async () => {
    const { StateManager } = await import('./state/state-manager.js')
    const { AuditLogger } = await import('./logger/audit-logger.js')

    const sm = new StateManager(tmpDir)
    sm.updateState(s => {
      s.features['my-feat'] = {
        spec_path: null,
        registration_source: 'registered_explicitly',
        current_phase: 'specify',
        current_step: 0,
        total_steps: 0,
        phases_completed: [],
        phases_skipped: {},
        phases_satisfied: {},
        created_at: '2026-03-10T12:00:00Z',
        updated_at: '2026-03-10T12:00:00Z',
      }
      s.active_feature = 'my-feat'
    })

    // Записываем событие напрямую
    const logger = new AuditLogger(tmpDir)
    logger.log({
      timestamp: '2026-03-10T12:00:00Z',
      feature: 'my-feat',
      action: 'feature_register',
    })

    const { client } = await setupServer(tmpDir)
    const result = await client.callTool({ name: 'session_log', arguments: {} })
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)

    expect(parsed.total).toBe(1)
    expect(parsed.events[0].action).toBe('feature_register')
  })

  // feature_register + feature_scan
  it('feature_register: регистрирует фичу через MCP', async () => {
    const { client } = await setupServer(tmpDir)

    const result = await client.callTool({
      name: 'feature_register',
      arguments: { name: 'my-new-feature' },
    })
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)

    expect(parsed.registered).toBe('my-new-feature')
    expect(parsed.current_phase).toBe('specify')
    expect(parsed.pipeline).toBe('stc')
  })

  it('feature_register: дубликат → ошибка', async () => {
    const { client } = await setupServer(tmpDir)

    await client.callTool({ name: 'feature_register', arguments: { name: 'feat-a' } })
    const result = await client.callTool({ name: 'feature_register', arguments: { name: 'feat-a' } })

    expect(result.isError).toBe(true)
  })

  it('feature_scan: находит спеки в .claude/specs/', async () => {
    const specsDir = join(tmpDir, '.claude', 'specs')
    mkdirSync(specsDir, { recursive: true })
    writeFileSync(join(specsDir, 'auth-system.md'), '# SPEC')
    writeFileSync(join(specsDir, 'payments.md'), '# SPEC')

    const { client } = await setupServer(tmpDir)
    const result = await client.callTool({ name: 'feature_scan', arguments: {} })
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)

    expect(parsed.total_discovered).toBe(2)
    expect(parsed.discovered).toContain('auth-system')
    expect(parsed.discovered).toContain('payments')
  })

  it('HP-1 E2E: полный цикл register → advance → done', async () => {
    const { client } = await setupServer(tmpDir)

    // Регистрируем
    await client.callTool({ name: 'feature_register', arguments: { name: 'e2e-feat' } })

    // Статус — specify
    let result = await client.callTool({ name: 'phase_status', arguments: {} })
    let parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(parsed.current_phase).toBe('specify')

    // specify → clarify
    await client.callTool({ name: 'phase_advance', arguments: {} })
    // clarify → plan (skip)
    await client.callTool({ name: 'phase_advance', arguments: { skip_reason: 'Clarify не нужен — спека полностью описывает задачу, вопросов нет' } })
    // plan → test
    await client.callTool({ name: 'phase_advance', arguments: {} })
    // test → code (satisfy)
    await client.callTool({ name: 'phase_advance', arguments: { satisfy_evidence: 'Tests already exist in test suite and fully cover all business logic for this step. Проверено: 12 тестов в tests/feature.test.ts покрывают create/update/delete/list. Этот шаг — только конфиг и типы, новой тестируемой логики нет.' } })
    // code → verify
    await client.callTool({ name: 'phase_advance', arguments: {} })
    // verify: сначала verify_checklist (hard gate v0.5)
    await client.callTool({
      name: 'verify_checklist',
      arguments: {
        code_review: { status: 'passed', summary: 'E2E тест — проверено 5 файлов, багов не найдено' },
        security_check: { status: 'passed', summary: 'Секретов и инъекций не найдено, deps чистые' },
      },
    })
    // verify → commit
    await client.callTool({ name: 'phase_advance', arguments: {} })
    // commit → done
    result = await client.callTool({ name: 'phase_advance', arguments: {} })
    parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)

    expect(parsed.is_done).toBe(true)

    // Лог содержит все transitions
    result = await client.callTool({ name: 'session_log', arguments: { feature: 'e2e-feat' } })
    parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(parsed.total).toBe(9) // register + 7 transitions + 1 verify_check
  })

  it('session_log с фильтром по feature', async () => {
    const { AuditLogger } = await import('./logger/audit-logger.js')
    const logger = new AuditLogger(tmpDir)
    logger.log({ timestamp: '2026-03-10T12:00:00Z', feature: 'feat-a', action: 'phase_advance' })
    logger.log({ timestamp: '2026-03-10T12:01:00Z', feature: 'feat-b', action: 'phase_advance' })

    const { client } = await setupServer(tmpDir)
    const result = await client.callTool({
      name: 'session_log',
      arguments: { feature: 'feat-a' },
    })
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)

    expect(parsed.total).toBe(1)
    expect(parsed.events[0].feature).toBe('feat-a')
  })
})
