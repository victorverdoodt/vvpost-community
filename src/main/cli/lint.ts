import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Io } from './index'

export const LINT_HELP_OPTIONS = `Opções de lint (regras de .vvpost/ruleset.yaml; sem ele, o vvpost:recommended; docs/lint.md):
  --ruleset <arquivo>   Outro ruleset (YAML ou JSON, no formato do Spectral)
  --fail-on <nível>     Sai com 2 a partir deste nível: error (padrão), warn, info ou hint
  --json <arquivo>      Relatório JSON ("-" escreve no stdout no lugar da saída de texto)
  --junit <arquivo>     Relatório JUnit XML: um caso por achado do nível de --fail-on para cima
  --sarif <arquivo>     Relatório SARIF 2.1.0 para o code scanning do GitHub ("-" escreve no stdout)
  --quiet               Mostra só erros e avisos (os relatórios levam tudo)
  --fix                 Corrige antes os diagramas de arquitetura que divergem do catálogo (elemento
                        que falta ou sobrou, relações dos fluxos) e lista o que mudou
`

const LEVELS = ['error', 'warn', 'info', 'hint'] as const
type Level = (typeof LEVELS)[number]

export interface LintValues {
  ruleset?: string | undefined
  'fail-on'?: string | undefined
  json?: string | undefined
  junit?: string | undefined
  sarif?: string | undefined
  quiet?: boolean | undefined
  fix?: boolean | undefined
}

/** vvpost lint: sai com 0 sem achado no nível de --fail-on, 2 com achado ou com ruleset inválido. */
export async function lintCommand(dir: string, io: Io, values: LintValues, version: string): Promise<number> {
  const failOn = (values['fail-on'] ?? 'error') as Level
  if (!LEVELS.includes(failOn)) {
    io.stderr(`vvpost: --fail-on ${failOn}: use error, warn, info ou hint\n`)
    return 2
  }
  if (values.json === '-' && values.sarif === '-') {
    io.stderr('vvpost: --json - e --sarif - não cabem juntos no stdout; grave um deles num arquivo\n')
    return 2
  }
  const [{ lintWorkspace }, reports, { RulesetError, failsAt }] = await Promise.all([import('../lint'), import('../lint/reports'), import('@vvpost/core/lint')])
  let result
  try {
    if (values.fix) {
      const { loadWorkspace } = await import('@vvpost/core/connectors/workspace')
      const ws = await loadWorkspace(dir)
      const { drift } = await lintWorkspace(dir, { ws, noHistory: true, ...(values.ruleset && { ruleset: resolve(io.cwd, values.ruleset) }) })
      const plan = await (await import('../lint/architecture')).fixDiagrams(dir, drift, { apply: true, ws })
      for (const f of plan.files) io.stderr(`corrigido: ${f.file} (${f.fixes.length}: ${[...new Set(f.fixes.map((x) => x.code))].join(', ')})\n`)
    }
    result = await lintWorkspace(dir, { ...(values.ruleset && { ruleset: resolve(io.cwd, values.ruleset) }) })
  } catch (err) {
    io.stderr(`vvpost: ${err instanceof RulesetError ? err.message : ((err as Error).stack ?? String(err))}\n`)
    return 2
  }
  for (const issue of result.issues) io.stderr(`aviso: ${issue}\n`)
  const write = async (target: string, text: string) => {
    const path = resolve(io.cwd, target)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
  }
  const json = reports.jsonLintReport(result)
  const sarif = reports.sarifReport(result, dir, io.cwd, version)
  if (values.json === '-') io.stdout(json)
  else if (values.sarif === '-') io.stdout(sarif)
  else io.stdout(reports.textReport(result, { quiet: values.quiet === true }))
  if (values.json !== undefined && values.json !== '-') await write(values.json, json)
  if (values.sarif !== undefined && values.sarif !== '-') await write(values.sarif, sarif)
  if (values.junit !== undefined) await write(values.junit, reports.junitLintReport(result, failOn))
  return failsAt(result.findings, failOn) ? 2 : 0
}
