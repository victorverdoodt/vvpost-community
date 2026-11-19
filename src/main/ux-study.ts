import { appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { FlowRunReport, HttpRequestInput, HttpResult, ScenarioRunReport } from '@shared/ipc'

/**
 * Instrumentação local do teste com usuários. Desligada por
 * padrão: só grava com VVPOST_UX_STUDY=<pasta> ou --ux-study=<pasta>, e a status bar mostra que
 * está gravando. Cada evento vira uma linha JSON em <pasta>/session-<início>.jsonl, no disco do
 * participante, sem rede. Nunca grava URL, header, corpo, nome de variável ou valor de segredo:
 * só o tipo do evento, ids de módulo e de conector, códigos de erro, status e tempos.
 */

const EVENTS = new Set([
  'session',
  'module',
  'module-ready',
  'workspace',
  'environment',
  'request',
  'scenarios',
  'flow',
  'error-shown',
  'open-in-quick'
])

const MAX_TEXT = 80
let file: string | null = null
let started = 0

function studyDir(): string | null {
  const arg = process.argv.find((a) => a.startsWith('--ux-study='))?.slice('--ux-study='.length)
  const dir = arg || process.env['VVPOST_UX_STUDY']
  return dir ? resolve(dir) : null
}

export function startUxStudy(): void {
  const dir = studyDir()
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  started = Date.now()
  file = join(dir, `session-${new Date(started).toISOString().replace(/[:.]/g, '-')}.jsonl`)
  trackUx('session', { platform: process.platform })
}

export function uxStudyEnabled(): boolean {
  return file !== null
}

/** Só valores curtos e primitivos; o resto é descartado (nada de objetos vindos do renderer). */
function clean(data: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  if (!data || typeof data !== 'object') return out
  for (const [k, v] of Object.entries(data).slice(0, 12)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 10) / 10
    else if (typeof v === 'boolean') out[k] = v
    else if (typeof v === 'string') out[k] = v.slice(0, MAX_TEXT)
  }
  return out
}

export function trackUx(type: unknown, data?: unknown): void {
  if (!file || typeof type !== 'string' || !EVENTS.has(type)) return
  const line = { t: Date.now() - started, type, ...clean(data) }
  try {
    appendFileSync(file, `${JSON.stringify(line)}\n`)
  } catch (err) {
    console.error('Estudo de UX: falha ao gravar o evento', err)
  }
}

/** Resultado de uma requisição do Quick Request: ok, status ou código de erro, tempo. */
export function trackRequest(result: HttpResult, input: HttpRequestInput): void {
  if (!file) return
  trackUx('request', {
    ok: result.ok,
    ...(result.ok
      ? { status: result.response.status, ms: result.response.timings.totalMs }
      : { code: result.error.code, ms: result.timings.totalMs }),
    connector: input.connectorId ?? '',
    environment: input.environmentId ?? ''
  })
}

/** Lote de cenários: totais por resultado. */
export function trackScenarios(report: ScenarioRunReport): void {
  if (!file) return
  trackUx('scenarios', { ...report.totals, failedToRun: !!report.error, canceled: report.canceled })
}

/** Execução de fluxo: desfecho e o primeiro nó com erro. */
export function trackFlow(report: FlowRunReport): void {
  if (!file) return
  const failed = report.results.find((n) => n.status === 'error')
  trackUx('flow', {
    outcome: report.outcome,
    ms: report.durationMs,
    ...(failed && { failedNode: failed.name, code: failed.error?.code ?? '' })
  })
}
