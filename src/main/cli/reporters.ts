import type { FlowNodeResult, ScenarioResult } from '@shared/ipc'
import type { CliRunResult, RunSummary } from './run'

/** Versão do formato do relatório JSON (`--json`). Muda só com quebra de compatibilidade. */
export const JSON_REPORT_VERSION = 1

export function jsonReport(result: CliRunResult, summary: RunSummary): string {
  return `${JSON.stringify({ version: JSON_REPORT_VERSION, ...summary, ...result }, null, 2)}\n`
}

// --- JUnit XML (o formato que GitHub Actions, GitLab, Azure DevOps e Jenkins leem) ---

/** Tira os caracteres que o XML 1.0 não aceita e escapa o resto. */
export function xml(text: string): string {
  return text
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const seconds = (ms: number) => (ms / 1000).toFixed(3)
const envLabel = (id: string) => (id ? ` [${id}]` : '')
const iterationLabel = (n: number | undefined) => (n === undefined ? '' : ` #${n}`)

interface Case {
  classname: string
  name: string
  timeMs: number
  failure?: { message: string; detail: string }
  error?: { message: string; detail: string }
  skipped?: string
  output?: string
}

interface Suite {
  name: string
  timeMs: number
  timestamp: number
  cases: Case[]
}

function scenarioCase(connectorId: string, r: ScenarioResult): Case {
  const base: Case = {
    classname: `${connectorId}.${r.endpointId}`,
    name: `${r.scenarioId}${envLabel(r.environmentId)}${iterationLabel(r.iteration)}`,
    timeMs: r.durationMs
  }
  const request = `${r.request.method} ${r.request.url}${r.status !== undefined ? ` → ${r.status}` : ''}`
  if (r.outcome === 'error') {
    const message = r.error ? `${r.error.code}: ${r.error.message}` : 'erro'
    return { ...base, error: { message, detail: `${request}\n${message}` } }
  }
  if (r.outcome === 'failed') {
    const failed = r.assertions.filter((a) => !a.passed)
    const lines = failed.map((a) => `${a.target} ${a.operator}: ${a.message}`)
    return {
      ...base,
      failure: { message: lines[0] ?? 'asserção falhou', detail: [request, ...lines].join('\n') },
      ...(r.bodyPreview && { output: r.bodyPreview })
    }
  }
  return base
}

function nodeCase(flowId: string, environmentId: string, n: FlowNodeResult): Case {
  const base: Case = { classname: `flow.${flowId}${envLabel(environmentId)}`, name: n.name, timeMs: n.durationMs }
  const output = n.logs || undefined
  if (n.status === 'skipped') return { ...base, skipped: n.reason ?? 'pulado' }
  if (n.status === 'error') {
    const message = n.error ? `${n.error.code}: ${n.error.message}` : 'erro'
    const request = n.request ? `${n.request.method} ${n.request.url}\n` : ''
    return { ...base, failure: { message, detail: `${request}${message}` }, ...(output && { output }) }
  }
  return { ...base, ...(output && { output }) }
}

function suites(result: CliRunResult): Suite[] {
  const out: Suite[] = []
  for (const report of result.scenarios) {
    const cases = report.results.map((r) => scenarioCase(report.connectorId, r))
    if (report.error !== undefined) {
      cases.push({ classname: report.connectorId, name: 'configuração', timeMs: 0, error: { message: report.error, detail: report.error } })
    }
    out.push({ name: `scenarios.${report.connectorId}`, timeMs: report.durationMs, timestamp: report.startedAt, cases })
  }
  for (const { report, environmentId } of result.flows) {
    const cases = report.results.map((n) => nodeCase(report.flowId, environmentId, n))
    if (report.error !== undefined) {
      cases.push({
        classname: `flow.${report.flowId}${envLabel(environmentId)}`,
        name: 'configuração',
        timeMs: 0,
        error: { message: report.error, detail: report.error }
      })
    }
    out.push({ name: `flow.${report.flowId}${envLabel(environmentId)}`, timeMs: report.durationMs, timestamp: report.startedAt, cases })
  }
  return out
}

export function junitReport(result: CliRunResult): string {
  const all = suites(result)
  const count = (s: Suite[], pick: (c: Case) => unknown) => s.reduce((n, x) => n + x.cases.filter(pick).length, 0)
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="vvpost" tests="${count(all, () => true)}" failures="${count(all, (c) => c.failure)}" errors="${count(all, (c) => c.error)}" skipped="${count(all, (c) => c.skipped)}" time="${seconds(result.durationMs)}">`
  ]
  for (const suite of all) {
    const attrs = [
      `name="${xml(suite.name)}"`,
      `tests="${suite.cases.length}"`,
      `failures="${suite.cases.filter((c) => c.failure).length}"`,
      `errors="${suite.cases.filter((c) => c.error).length}"`,
      `skipped="${suite.cases.filter((c) => c.skipped).length}"`,
      `time="${seconds(suite.timeMs)}"`,
      `timestamp="${new Date(suite.timestamp).toISOString().slice(0, 19)}"`
    ]
    lines.push(`  <testsuite ${attrs.join(' ')}>`)
    for (const c of suite.cases) {
      const open = `    <testcase classname="${xml(c.classname)}" name="${xml(c.name)}" time="${seconds(c.timeMs)}"`
      const body: string[] = []
      if (c.failure) body.push(`      <failure message="${xml(c.failure.message)}">${xml(c.failure.detail)}</failure>`)
      if (c.error) body.push(`      <error message="${xml(c.error.message)}">${xml(c.error.detail)}</error>`)
      if (c.skipped) body.push(`      <skipped message="${xml(c.skipped)}"/>`)
      if (c.output) body.push(`      <system-out>${xml(c.output)}</system-out>`)
      lines.push(body.length ? `${open}>\n${body.join('\n')}\n    </testcase>` : `${open}/>`)
    }
    lines.push('  </testsuite>')
  }
  lines.push('</testsuites>', '')
  return lines.join('\n')
}

// --- Saída para o terminal ---

export interface PrettyOptions {
  color: boolean
  /** Só falhas e o resumo. */
  quiet: boolean
}

const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace('.', ',')} s` : `${Math.round(n)} ms`)

export function prettyReport(result: CliRunResult, summary: RunSummary, options: PrettyOptions): string {
  const paint = (code: string) => (text: string) => (options.color ? `\x1b[${code}m${text}\x1b[0m` : text)
  const green = paint('32')
  const red = paint('31')
  const yellow = paint('33')
  const dim = paint('2')
  const bold = paint('1')
  const out: string[] = []

  for (const issue of result.issues) out.push(yellow(`aviso: ${issue.file}: ${issue.message} (ignorado)`))
  if (result.issues.length) out.push('')

  for (const report of result.scenarios) {
    const { passed, failed, error } = report.totals
    const data = report.data ? `, ${report.data.iterations} iterações${report.data.name ? ` de ${report.data.name}` : ''}` : ''
    out.push(bold(`Cenários · ${report.connectorId}`) + dim(` (${passed + failed + error}${data}, ${ms(report.durationMs)})`))
    if (report.error !== undefined) out.push(`  ${red('✗')} ${red(report.error)}`)
    for (const r of report.results) {
      if (options.quiet && r.outcome === 'passed') continue
      const mark = r.outcome === 'passed' ? green('✓') : r.outcome === 'failed' ? red('✗') : red('!')
      const env = r.environmentId ? `${dim(r.environmentId)} ` : ''
      const status = r.status !== undefined ? ` ${r.status}` : ''
      const iteration = r.iteration !== undefined ? `${dim(`#${r.iteration}`)} ` : ''
      out.push(`  ${mark} ${iteration}${env}${r.endpointId}/${r.scenarioId}${dim(`${status} · ${ms(r.durationMs)}`)}`)
      // A URL como foi montada: mostra a codificação dos pathParams (um %E0 que virou %25E0, por exemplo).
      if (r.outcome !== 'passed' && r.request?.url) out.push(`      ${dim(`${r.request.method} ${r.request.url}`)}`)
      if (r.error) out.push(`      ${red(`${r.error.code}: ${r.error.message}`)}`)
      for (const a of r.assertions) if (!a.passed) out.push(`      ${red(`${a.target} ${a.operator}: ${a.message}`)}`)
    }
    out.push('')
  }

  for (const { report, environmentId, file } of result.flows) {
    const mark = report.outcome === 'success' ? green('✓') : red('✗')
    const env = environmentId ? ` [${environmentId}]` : ''
    out.push(`${bold(`Fluxo · ${report.flowId || file}${env}`)} ${mark}${dim(` (${report.results.length} nós, ${ms(report.durationMs)})`)}`)
    if (report.error !== undefined) out.push(`  ${red(report.error)}`)
    for (const n of report.results) {
      if (options.quiet && n.status !== 'error') continue
      const nodeMark = n.status === 'success' ? green('✓') : n.status === 'skipped' ? dim('-') : red('✗')
      const detail = n.status === 'skipped' ? ` · ${n.reason ?? 'pulado'}` : ` · ${ms(n.durationMs)}`
      const python = n.python ? ` · Python ${n.python}` : ''
      out.push(`  ${nodeMark} ${n.name}${dim(detail + python)}`)
      if (n.status === 'error' && n.request) out.push(`      ${dim(`${n.request.method} ${n.request.url}`)}`)
      if (n.error) out.push(`      ${red(`${n.error.code}: ${n.error.message}`)}`)
    }
    out.push('')
  }

  const parts: string[] = []
  const s = summary.scenarios
  if (result.scenarios.length) {
    parts.push(
      [`${s.passed} cenários passaram`, s.failed && red(`${s.failed} falharam`), s.error && red(`${s.error} com erro`)]
        .filter(Boolean)
        .join(', ')
    )
  }
  if (result.flows.length) {
    parts.push([`${summary.flows.success} fluxos ok`, summary.flows.failed && red(`${summary.flows.failed} falharam`)].filter(Boolean).join(', '))
  }
  const verdict = {
    passed: green('PASSOU'),
    failed: red('FALHOU'),
    error: red('ERRO DE CONFIGURAÇÃO'),
    canceled: yellow('INTERROMPIDO')
  }[summary.outcome]
  out.push(`${bold(verdict)} · ${parts.join(' · ')} · ${ms(result.durationMs)}`)
  return `${out.join('\n')}\n`
}
