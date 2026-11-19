#!/usr/bin/env node
// Resumo das sessões gravadas no teste com usuários: lê os session-*.jsonl
// gravados com --ux-study=<pasta> e gera os indicadores do estudo por sessão.
// Uso: node scripts/ux-study-report.mjs <pasta ou arquivos .jsonl>
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Indicadores de uma sessão a partir dos eventos ({ t, type, ... }). Exportado para o E2E. */
export function summarize(events) {
  const of = (type) => events.filter((e) => e.type === type)
  const requests = of('request')
  const firstOk = requests.find((r) => r.ok && r.status < 400)
  const workspace = of('workspace').find((w) => w.opened)
  const ready = of('module-ready')
    .map((e) => e.ms)
    .sort((a, b) => a - b)
  const pct = (p) => (ready.length ? ready[Math.min(ready.length - 1, Math.floor((p / 100) * ready.length))] : null)
  const count = (list, key) => list.reduce((m, e) => ((m[e[key]] = (m[e[key]] ?? 0) + 1), m), {})
  return {
    durationS: events.length ? Math.round(events.at(-1).t / 1000) : 0,
    firstSuccessS: firstOk ? Math.round((firstOk.t - (workspace?.t ?? 0)) / 1000) : null,
    requestsBeforeFirstSuccess: firstOk ? requests.indexOf(firstOk) : requests.length,
    requests: requests.length,
    requestErrors: count(
      requests.filter((r) => !r.ok),
      'code'
    ),
    errorsShown: count(of('error-shown'), 'category'),
    modules: count(of('module'), 'id'),
    moduleReadyMs: { p50: pct(50), p95: pct(95) },
    environmentChanges: of('environment').length,
    openInQuick: count(of('open-in-quick'), 'from'),
    scenarioRuns: of('scenarios').length,
    flowRuns: count(of('flow'), 'outcome')
  }
}

function read(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

const fmt = (v) =>
  v === null
    ? '—'
    : typeof v === 'object'
      ? Object.entries(v)
          .map(([k, n]) => `${k} ${n}`)
          .join(', ') || '—'
      : String(v)

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2).flatMap((p) =>
    statSync(p).isDirectory()
      ? readdirSync(p)
          .filter((f) => /^session-.*\.jsonl$/.test(f))
          .map((f) => join(p, f))
      : [p]
  )
  if (!files.length) {
    console.error('Uso: node scripts/ux-study-report.mjs <pasta ou arquivos session-*.jsonl>')
    process.exit(1)
  }
  const rows = [
    ['Duração (s)', 'durationS'],
    ['Até a 1ª resposta ok (s, desde o workspace)', 'firstSuccessS'],
    ['Envios antes da 1ª resposta ok', 'requestsBeforeFirstSuccess'],
    ['Requisições', 'requests'],
    ['Erros de envio por código', 'requestErrors'],
    ['Erros vistos por categoria', 'errorsShown'],
    ['Módulos abertos', 'modules'],
    ['Troca de módulo (ms, p50 / p95)', 'moduleReadyMs'],
    ['Trocas de ambiente', 'environmentChanges'],
    ['Abrir no Quick Request (origem)', 'openInQuick'],
    ['Lotes de cenários', 'scenarioRuns'],
    ['Fluxos por desfecho', 'flowRuns']
  ]
  const sessions = files.map((f) => ({ name: basename(f, '.jsonl').replace('session-', ''), s: summarize(read(f)) }))
  console.log(`| Indicador | ${sessions.map((x) => x.name).join(' | ')} |`)
  console.log(`| --- | ${sessions.map(() => '---').join(' | ')} |`)
  for (const [label, key] of rows) console.log(`| ${label} | ${sessions.map((x) => fmt(x.s[key])).join(' | ')} |`)
}
