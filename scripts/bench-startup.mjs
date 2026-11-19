#!/usr/bin/env node
// Mede cold start e RAM em repouso do build de produção (out/) e compara com
// perf-budgets.json. Uso: npm run build && npm run bench [-- --runs 5] [-- --report-only]
// [-- --app dist/linux-unpacked/vvpost-desktop] (o app empacotado, ver docs/packaging.md)
//
// - coldStartMs: tempo de parede do spawn do Electron até o primeiro paint do renderer.
// - idleMemoryMB: memória somada de todos os processos, medida após alguns segundos
//   parado depois do primeiro paint (PSS no Linux, private bytes no Windows; ver
//   src/main/memory.ts).
// - dispatchOverheadMs: quanto o caminho do Quick Request (IPC, herança, auth, gravador,
//   sanitizer, histórico) acrescenta a uma requisição em loopback, além do Undici direto
//   (src/main/bench.ts).
// O valor reportado é a mediana das execuções.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const electronBin = require('electron')

const args = process.argv.slice(2)
const runs = Number(args[args.indexOf('--runs') + 1]) || 5
const reportOnly = args.includes('--report-only')
// --app <executável>: mede o app empacotado (dist/linux-unpacked/vvpost-desktop, por exemplo)
// em vez do build de out/ no Electron do node_modules.
const appExe = args.includes('--app') ? args[args.indexOf('--app') + 1] : null
const budgets = JSON.parse(readFileSync(join(root, 'perf-budgets.json'), 'utf8'))

if (!appExe && !existsSync(join(root, 'out/main/index.js'))) {
  console.error('Build não encontrado. Rode "npm run build" antes do benchmark.')
  process.exit(1)
}

// Electron recusa rodar como root sem --no-sandbox (containers de CI), e num Linux que restringe
// user namespaces sem privilégio (Ubuntu 24.04 com AppArmor, o runner do GitHub) aborta quando o
// chrome-sandbox não é setuid root (o do node_modules). Mesma regra do sandboxArgs do print-spawn.
function noSandbox(executable) {
  if (process.platform !== 'linux') return false
  if (process.getuid?.() === 0) return true
  try {
    if (readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() !== '1') return false
  } catch {
    return false
  }
  try {
    const helper = statSync(join(dirname(executable), 'chrome-sandbox'))
    return !(helper.uid === 0 && (helper.mode & 0o4000) !== 0)
  } catch {
    return true
  }
}
// Pasta de dados própria: o benchmark roda com o VVPost aberto (o lock de instância
// única é por pasta de dados) e mede sempre o mesmo boot, sem o workspace do usuário.
// Uma pasta por execução: a medição do disparo grava no histórico e abre um workspace, e a
// execução seguinte não pode bootar com eles.
const dataDirs = []
process.on('exit', () => dataDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const extraArgs = () => {
  const userData = mkdtempSync(join(tmpdir(), 'vvpost-bench-data-'))
  dataDirs.push(userData)
  return [...(noSandbox(appExe ?? electronBin) ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`]
}

function runOnce() {
  return new Promise((resolve, reject) => {
    const start = performance.now()
    let coldStartMs = null
    let buffer = ''
    const child = spawn(appExe ?? electronBin, appExe ? extraArgs() : [...extraArgs(), root], {
      env: { ...process.env, VVPOST_BENCH: '1', ELECTRON_ENABLE_LOGGING: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Timeout: o app não reportou o benchmark em 30 s'))
    }, 30_000)

    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line === 'VVPOST_BENCH_PAINT') {
          coldStartMs = Math.round(performance.now() - start)
        } else if (line.startsWith('VVPOST_BENCH ')) {
          clearTimeout(timeout)
          resolve({ coldStartMs, ...JSON.parse(line.slice('VVPOST_BENCH '.length)) })
        }
      }
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      process.stderr.write(chunk)
    })
    child.on('exit', (code) => {
      clearTimeout(timeout)
      // O app sai com 0 e sem paint quando outra instância já tem o lock da mesma pasta de dados.
      const why = /VVPOST_SINGLE_INSTANCE/.test(stderr)
        ? ': outra instância do VVPost usa a mesma pasta de dados (feche-a ou rode com --user-data-dir próprio)'
        : coldStartMs === null
          ? ': o app fechou antes do primeiro paint (veja o stderr acima)'
          : ''
      reject(new Error(`Electron saiu (código ${code}) sem reportar o benchmark${why}`))
    })
  })
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

const medianFloat = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return Math.round((sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100
}

const samples = []
for (let i = 0; i < runs; i++) {
  const sample = await runOnce()
  samples.push(sample)
  console.log(
    `run ${i + 1}/${runs}: cold start ${sample.coldStartMs} ms, RAM em repouso ${sample.idleMemoryMB} MB, Secret Engine +${sample.secretEngineMB} MB, overhead de disparo ${sample.dispatchOverheadMs} ms (${sample.dispatch?.appMs} ms no app, ${sample.dispatch?.rawMs} ms direto)`
  )
}

// A primeira execução aquece o cache de disco do SO; ela entra na mediana mesmo assim
// para não esconder o custo de um primeiro boot.
const result = {
  coldStartMs: median(samples.map((s) => s.coldStartMs)),
  idleMemoryMB: median(samples.map((s) => s.idleMemoryMB)),
  secretEngineMB: median(samples.map((s) => s.secretEngineMB ?? Infinity)),
  dispatchOverheadMs: medianFloat(samples.map((s) => s.dispatchOverheadMs ?? Infinity)),
  memoryMetric: samples[0].memoryMetric,
  electron: samples[0].electron,
  platform: samples[0].platform,
  idleByProcessType: samples.at(-1).idleByProcessType,
  runs
}
writeFileSync(join(root, 'bench-results.json'), JSON.stringify({ result, samples }, null, 2))

const check = (name, key, unit) => {
  const { max, enforce } = budgets[key]
  return { name, value: `${result[key]} ${unit}`, budget: `< ${max} ${unit}`, ok: result[key] < max, enforce }
}
const rows = [
  check('Cold start', 'coldStartMs', 'ms'),
  check(`RAM em repouso (${result.memoryMetric})`, 'idleMemoryMB', 'MB'),
  check('Secret Engine ligado (main process)', 'secretEngineMB', 'MB'),
  check('Overhead de disparo (Quick Request)', 'dispatchOverheadMs', 'ms')
]
const status = (r) => (r.ok ? '✅' : r.enforce ? '❌' : '⚠️ só reportado')
console.log(`\nVVPost ${result.platform} · Electron ${result.electron} · mediana de ${runs} execuções`)
console.table(Object.fromEntries(rows.map((r) => [r.name, { valor: r.value, meta: r.budget, status: status(r) }])))
console.log('RAM por processo (MB):', result.idleByProcessType)

if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [
    `### Benchmark de startup (${result.platform}, Electron ${result.electron})`,
    '',
    '| Métrica | Valor | Meta | |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.name} | ${r.value} | ${r.budget} | ${status(r)} |`),
    ''
  ].join('\n')
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, md, { flag: 'a' })
}

// Depois do boot: abertura e volta de cada módulo e a primeira execução.
await import('./bench-modules.mjs')

const failed = rows.filter((r) => !r.ok && r.enforce)
if (failed.length && !reportOnly) {
  console.error(`\nMeta estourada: ${failed.map((r) => r.name).join(', ')}`)
  process.exit(1)
}
