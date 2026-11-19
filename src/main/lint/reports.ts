import { join, relative, sep } from 'node:path'
import { SEVERITIES, type LintFinding, type LintSeverity } from '@vvpost/core/lint'
import { xml } from '../cli/reporters'
import { summaryLine, type WorkspaceLintResult } from './index'

/**
 * Saídas do `vvpost lint`: texto para a pessoa no terminal, JSON, JUnit (o que os CIs mostram como
 * testes) e SARIF 2.1.0 (o code scanning do GitHub e o Azure DevOps marcam as linhas no PR).
 */

const DOCS_URL = 'https://github.com/victorverdoodt/vvpost-community/blob/main/docs/lint.md'
const LABEL: Record<LintSeverity, string> = { error: 'erro', warn: 'aviso', info: 'info', hint: 'dica' }

const atOrAbove = (f: LintFinding, failOn: LintSeverity) => SEVERITIES.indexOf(f.severity) <= SEVERITIES.indexOf(failOn)

export function textReport(result: WorkspaceLintResult, options: { quiet?: boolean } = {}): string {
  const shown = options.quiet ? result.findings.filter((f) => f.severity === 'error' || f.severity === 'warn') : result.findings
  const lines: string[] = []
  let file = ''
  for (const f of shown) {
    if (f.file !== file) {
      if (file) lines.push('')
      file = f.file
      lines.push(file)
    }
    const where = f.line !== undefined ? String(f.line).padStart(5) : '     '
    lines.push(`${where}  ${LABEL[f.severity].padEnd(5)}  ${f.code.padEnd(26)} ${f.label ? `${f.label}: ` : ''}${f.message}`)
  }
  if (lines.length) lines.push('')
  const total = result.findings.length
  lines.push(total ? `${total} ${total === 1 ? 'achado' : 'achados'}: ${summaryLine(result.summary)}` : 'Lint ok: nenhum achado')
  lines.push(`Ruleset: ${result.ruleset ?? 'vvpost:recommended (padrão)'}`)
  return `${lines.join('\n')}\n`
}

/** Versão do formato do relatório JSON do lint. Muda só com quebra de compatibilidade. */
export const LINT_JSON_VERSION = 1

export function jsonLintReport(result: WorkspaceLintResult): string {
  return `${JSON.stringify(
    {
      version: LINT_JSON_VERSION,
      ruleset: result.ruleset ?? 'vvpost:recommended',
      summary: result.summary,
      issues: result.issues,
      findings: result.findings.map(({ pointer: _pointer, ...f }) => f)
    },
    null,
    2
  )}\n`
}

export function junitLintReport(result: WorkspaceLintResult, failOn: LintSeverity): string {
  const failing = result.findings.filter((f) => atOrAbove(f, failOn))
  const byFile = new Map<string, LintFinding[]>()
  for (const f of failing) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f])
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', `<testsuites name="vvpost lint" tests="${Math.max(failing.length, 1)}" failures="${failing.length}">`]
  if (!failing.length) {
    out.push('  <testsuite name="vvpost lint" tests="1" failures="0">', '    <testcase classname="vvpost lint" name="nenhum achado"/>', '  </testsuite>')
  }
  for (const [file, list] of byFile) {
    out.push(`  <testsuite name="${xml(file)}" tests="${list.length}" failures="${list.length}">`)
    for (const f of list) {
      const where = `${file}${f.line !== undefined ? `:${f.line}` : ''}`
      out.push(
        `    <testcase classname="${xml(file)}" name="${xml(`${f.code} ${f.label ?? f.path}`)}">`,
        `      <failure message="${xml(f.message)}" type="${f.severity}">${xml(`${where} [${f.severity}] ${f.code}: ${f.message}${f.hint ? `\n${f.hint}` : ''}`)}</failure>`,
        '    </testcase>'
      )
    }
    out.push('  </testsuite>')
  }
  out.push('</testsuites>', '')
  return out.join('\n')
}

/**
 * SARIF 2.1.0. Os caminhos saem relativos a `base` (a pasta de onde o CLI roda, que no CI é a raiz
 * do repositório), como o code scanning do GitHub espera.
 */
export function sarifReport(result: WorkspaceLintResult, workspaceDir: string, base: string, version: string): string {
  const rules = [...new Map(result.findings.map((f) => [f.code, f])).values()]
  const index = new Map(rules.map((r, i) => [r.code, i]))
  const level = (s: LintSeverity) => (s === 'error' ? 'error' : s === 'warn' ? 'warning' : 'note')
  const uri = (file: string) => relative(base, join(workspaceDir, file)).split(sep).join('/')
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'vvpost lint',
            version,
            informationUri: DOCS_URL,
            rules: rules.map((r) => ({
              id: r.code,
              shortDescription: { text: r.hint ?? r.message },
              ...(r.hint && { help: { text: r.hint } }),
              helpUri: r.documentationUrl ?? DOCS_URL,
              defaultConfiguration: { level: level(r.severity) }
            }))
          }
        },
        results: result.findings.map((f) => ({
          ruleId: f.code,
          ruleIndex: index.get(f.code),
          level: level(f.severity),
          message: { text: `${f.label ? `${f.label}: ` : ''}${f.message}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: uri(f.file) },
                region: { startLine: f.line ?? 1 }
              },
              logicalLocations: [{ fullyQualifiedName: f.path }]
            }
          ]
        }))
      }
    ]
  }
  return `${JSON.stringify(sarif, null, 2)}\n`
}
