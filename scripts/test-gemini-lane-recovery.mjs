import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const exhausted = []
const source = readFileSync(new URL('../lib/global-gemini-coordinator.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const coordinatorModule = new Module('test-global-gemini-coordinator')
coordinatorModule.require = (id) => {
  if (id === 'server-only') return {}
  if (id === './store') return {
    apiKeyHash: (key) => key,
    getModelUsage: () => 0,
    setModelExhausted: (...args) => exhausted.push(args),
    isModelDailyQuotaExhausted: () => false,
    geminiUsageDay: () => '2026-09-25',
    checkDailyReset: () => {},
  }
  if (id === './models') return {
    pacingIntervalMs: () => 0,
    RATE_COOLDOWN_MS: 40,
    CHUNK_COOLDOWN_MS: 40,
    displayModelName: (model) => model,
  }
  throw new Error(`Unexpected import: ${id}`)
}
coordinatorModule._compile(compiled, 'test-global-gemini-coordinator.js')
const Coordinator = coordinatorModule.exports.globalGeminiCoordinator.constructor
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

for (const operation of ['Chunk map', 'Verify', 'Rescan']) {
  test(`${operation}: three scans reserve a cooling model across slots and stagger sends`, async () => {
    const coordinator = new Coordinator()
    coordinator.reportRateLimit('shared-key', 'model-a', 40)
    const acquisitions = []
    const pending = [0, 1, 2].map((slot) =>
      coordinator.acquireLane({
        scanId: `scan-${slot}`,
        apiKey: 'shared-key',
        modelId: 'model-a',
        slot,
        operation,
        videoSeconds: 1,
      }).then((release) => {
        acquisitions.push({ slot, at: Date.now(), release })
      }),
    )

    assert.equal(coordinator.isLaneBusy('shared-key', 'model-a', 0).busy, true)
    await pause(200)
    assert.equal(acquisitions.length, 0)
    await pause(3_050)
    assert.equal(acquisitions.length, 1)
    assert.equal(coordinator.getSnapshot().filter((lane) => lane.activeScanId).length, 1)

    acquisitions[0].release(1, 0)
    await pause(200)
    assert.equal(acquisitions.length, 1)
    await pause(3_050)
    assert.equal(acquisitions.length, 2)
    assert.ok(acquisitions[1].at - acquisitions[0].at >= 3_000)
    acquisitions[1].release(1, 0)
    await pause(3_050)
    assert.equal(acquisitions.length, 3)
    assert.ok(acquisitions[2].at - acquisitions[1].at >= 3_000)
    acquisitions[2].release(1, 0)
    await Promise.all(pending)
    assert.equal(exhausted.length, 0)
  })
}

test('overlapping scans choose separate free models while a prepared request owns recovery', async () => {
  const coordinator = new Coordinator()
  coordinator.reportRateLimit('shared-key', 'model-a', 40)
  const reserved = coordinator.acquireLane({
    scanId: 'scan-a',
    apiKey: 'shared-key',
    modelId: 'model-a',
    operation: 'Prepared chunk',
    videoSeconds: 1,
  })
  const candidates = ['model-a', 'model-b', 'model-c'].map((modelId) => ({
    apiKey: 'shared-key',
    keyIdx: 1,
    modelId,
  }))
  const [b, c] = await Promise.all(['scan-b', 'scan-c'].map((scanId) =>
    coordinator.acquireFirstAvailableLane({ scanId, candidates, operation: 'Chunk map', videoSeconds: 1 }),
  ))
  assert.deepEqual(new Set([b.selected.modelId, c.selected.modelId]), new Set(['model-b', 'model-c']))
  b.release(1)
  c.release(1)
  const release = await reserved
  release(1, 0)
  assert.equal(exhausted.length, 0)
})

test('verify and rescan retries release the lane without counting temporary 429s as daily exhaustion', async () => {
  const events = []
  const usage = new Map()
  const coordinator = {
    acquireLane: async () => {
      events.push('acquire')
      return () => events.push('release')
    },
    reportRateLimit: () => events.push('cooldown'),
    handleQuotaOrRateError: () => {
      events.push('quota-check')
      return { action: 'cooldown' }
    },
    recordSuccess: () => events.push('success'),
  }
  class GeminiError extends Error {
    constructor(kind, message) {
      super(message)
      this.kind = kind
    }
  }
  const schedulerSource = readFileSync(new URL('../lib/scheduler.ts', import.meta.url), 'utf8')
  const schedulerCompiled = ts.transpileModule(schedulerSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const schedulerModule = new Module('test-scheduler')
  schedulerModule.require = (id) => {
    if (id === './global-gemini-coordinator') return { globalGeminiCoordinator: coordinator }
    if (id === './models') return {
      VERIFY_MODEL_POOL: [],
      CHUNK_COOLDOWN_MS: 70,
      RATE_COOLDOWN_MS: 60,
      pacingIntervalMs: () => 0,
      displayModelName: (id) => id,
    }
    if (id === './store') return {
      checkDailyReset: () => false,
      getModelUsage: (id) => usage.get(id) || 0,
      incrementModelUsage: (id) => {
        const count = (usage.get(id) || 0) + 1
        usage.set(id, count)
        return count
      },
      addLog: () => {},
      setModelExhausted: () => exhausted.push('scheduler'),
    }
    if (id === './gemini') return { GeminiError, classifyError: (err) => err }
    if (id.startsWith('node:')) return require(id)
    return {}
  }
  const originalSetInterval = globalThis.setInterval
  globalThis.setInterval = () => 0
  try {
    schedulerModule._compile(schedulerCompiled, 'test-scheduler.js')
  } finally {
    globalThis.setInterval = originalSetInterval
  }
  const scheduler = schedulerModule.exports.scheduler
  scheduler.stoppableSleep = async () => {}
  const job = {
    scan: { id: 'scan-verify', modelStates: {} },
    nextFreeAt: {},
    cooldownUntil: {},
    stopping: false,
  }
  const lane = { idx: 1, apiKey: 'shared-key' }
  const model = { id: 'model-a', rpd: 500 }
  for (const operation of ['Verify', 'Rescan']) {
    let sends = 0
    const send = () => scheduler.sendWithClipBackup(
      job,
      'prepared-uri',
      async () => {
        sends++
        if (sends < 3) throw new GeminiError('rate', '429: try again later')
        return operation
      },
      operation,
    )
    assert.equal(await scheduler.paceAndSend(job, lane, model, 1, send), operation)
    assert.equal(sends, 3)
  }
  assert.deepEqual(events, [
    'acquire', 'cooldown', 'release',
    'acquire', 'cooldown', 'release',
    'acquire', 'success', 'release',
    'acquire', 'cooldown', 'release',
    'acquire', 'cooldown', 'release',
    'acquire', 'success', 'release',
  ])
  assert.equal(exhausted.length, 0)
})
