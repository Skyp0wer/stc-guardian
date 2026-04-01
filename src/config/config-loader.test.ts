import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadConfig, DEFAULT_STC_CONFIG } from './config-loader.js'

describe('config-loader', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardian-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // EC-4: Нет config.yaml → дефолтный STC конфиг
  it('возвращает дефолтный STC конфиг если config.yaml нет', () => {
    const config = loadConfig(tmpDir)

    expect(config.pipeline.name).toBe('stc')
    expect(config.pipeline.phases).toHaveLength(7)
    expect(config.pipeline.phases[0].name).toBe('specify')
    expect(config.pipeline.phases[6].name).toBe('commit')
    expect(config.pipeline.phases[6].terminal).toBe(true)
  })

  // HP-5: Кастомный pipeline
  it('загружает кастомный pipeline из yaml', () => {
    const stcDir = join(tmpDir, '.stc')
    mkdirSync(stcDir, { recursive: true })
    writeFileSync(join(stcDir, 'config.yaml'), `
pipeline:
  name: "content"
  phases:
    - name: research
      required: true
    - name: draft
      required: true
    - name: review
      required: true
    - name: publish
      terminal: true
`)

    const config = loadConfig(tmpDir)

    expect(config.pipeline.name).toBe('content')
    expect(config.pipeline.phases).toHaveLength(4)
    expect(config.pipeline.phases[0].name).toBe('research')
    expect(config.pipeline.phases[3].name).toBe('publish')
    expect(config.pipeline.phases[3].terminal).toBe(true)
  })

  it('парсит все типы фаз: required, satisfiable, terminal', () => {
    const stcDir = join(tmpDir, '.stc')
    mkdirSync(stcDir, { recursive: true })
    writeFileSync(join(stcDir, 'config.yaml'), `
pipeline:
  name: "stc"
  phases:
    - name: specify
      required: true
    - name: clarify
      required: false
    - name: test
      satisfiable: true
    - name: commit
      terminal: true
`)

    const config = loadConfig(tmpDir)
    const phases = config.pipeline.phases

    expect(phases[0].required).toBe(true)
    expect(phases[1].required).toBe(false)
    expect(phases[2].satisfiable).toBe(true)
    expect(phases[3].terminal).toBe(true)
  })

  it('дефолтный конфиг содержит правильные типы фаз', () => {
    const config = DEFAULT_STC_CONFIG
    const phaseMap = Object.fromEntries(config.pipeline.phases.map(p => [p.name, p]))

    // required phases
    expect(phaseMap['specify'].required).toBe(true)
    expect(phaseMap['code'].required).toBe(true)
    expect(phaseMap['verify'].required).toBe(true)

    // skippable phases
    expect(phaseMap['clarify'].required).toBe(false)
    expect(phaseMap['plan'].required).toBe(false)

    // satisfiable
    expect(phaseMap['test'].satisfiable).toBe(true)

    // terminal
    expect(phaseMap['commit'].terminal).toBe(true)
  })

  it('невалидный yaml → ошибка', () => {
    const stcDir = join(tmpDir, '.stc')
    mkdirSync(stcDir, { recursive: true })
    writeFileSync(join(stcDir, 'config.yaml'), `
this is: [not valid: yaml: {{
`)

    expect(() => loadConfig(tmpDir)).toThrow()
  })

  it('pipeline без name → ошибка', () => {
    const stcDir = join(tmpDir, '.stc')
    mkdirSync(stcDir, { recursive: true })
    writeFileSync(join(stcDir, 'config.yaml'), `
pipeline:
  phases:
    - name: step1
`)

    expect(() => loadConfig(tmpDir)).toThrow(/pipeline.name/)
  })

  it('фаза с name: 123 (число) → ошибка', () => {
    const stcDir = join(tmpDir, '.stc')
    mkdirSync(stcDir, { recursive: true })
    writeFileSync(join(stcDir, 'config.yaml'), `
pipeline:
  name: "test"
  phases:
    - name: 123
`)

    expect(() => loadConfig(tmpDir)).toThrow(/name/)
  })

  it('фаза с пустым name → ошибка', () => {
    const stcDir = join(tmpDir, '.stc')
    mkdirSync(stcDir, { recursive: true })
    writeFileSync(join(stcDir, 'config.yaml'), `
pipeline:
  name: "test"
  phases:
    - name: ""
`)

    expect(() => loadConfig(tmpDir)).toThrow(/name/)
  })

  it('дубликат фаз → ошибка', () => {
    const stcDir = join(tmpDir, '.stc')
    mkdirSync(stcDir, { recursive: true })
    writeFileSync(join(stcDir, 'config.yaml'), `
pipeline:
  name: "test"
  phases:
    - name: code
      required: true
    - name: code
      required: true
`)

    expect(() => loadConfig(tmpDir)).toThrow(/дубликат/)
  })

  it('дефолтный конфиг immutable — loadConfig возвращает копию', () => {
    const config1 = loadConfig(tmpDir)
    config1.pipeline.phases.push({ name: 'extra' })

    const config2 = loadConfig(tmpDir)
    expect(config2.pipeline.phases).toHaveLength(7) // не 8
  })
})
