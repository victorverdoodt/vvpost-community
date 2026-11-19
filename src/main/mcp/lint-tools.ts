import type { LintFinding, LintSeverity } from '@vvpost/core/lint'
import { ToolError, type McpTool, type ToolContext } from './tools'

/**
 * O lint para o agente (docs/lint.md): `lint_project` devolve os achados com `code` e `hint`, e cada
 * escrita devolve os achados que ela trouxe (lintAfterWrite), comparando com a última leitura.
 */

const MAX_FINDINGS = 200
const AFTER_WRITE_FINDINGS = 5
const LEVELS: readonly LintSeverity[] = ['error', 'warn', 'info', 'hint']

/** Os achados da última leitura de cada pasta, para a escrita seguinte dizer só o que é novo. */
const lastSeen = new Map<string, Set<string>>()
const keyOf = (f: LintFinding) => `${f.code}\0${f.file}\0${f.path}\0${f.message}`

function forAgent(f: LintFinding, ctx: ToolContext) {
  return {
    code: f.code,
    severity: f.severity,
    file: f.file,
    ...(f.line !== undefined && { line: f.line }),
    ...(f.label && { where: ctx.sanitizer.text(f.label) }),
    message: ctx.sanitizer.text(f.message),
    ...(f.hint && { hint: f.hint }),
    ...(f.format !== 'vvpost' && { source: 'openapi' })
  }
}

const lintProject: McpTool = {
  name: 'lint_project',
  title: 'Conferir as regras de estilo e os erros comuns do projeto',
  description:
    'Roda o lint do projeto: o ruleset do time em .vvpost/ruleset.yaml (formato do Spectral, regras por JSONPath) ou o vvpost:recommended ' +
    '(descrição de conector e endpoint, resposta de exemplo com schema, cenário com asserção de status, caminho em kebab-case, segredo sem isSecret, ' +
    'página de docs/ sem endpoint citado, diagrama C4 que divergiu do catálogo e citação a endpoint ou conector removido) e, se o ruleset pedir, as regras de OpenAPI na spec exportada. Cada achado vem com code, arquivo, linha e hint ' +
    'de como corrigir. Complementa o vvpost validate (estrutura); o lint é estilo e completude.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      severity: { enum: LEVELS, description: 'Só achados deste nível para cima (padrão: hint, todos).' },
      file: { type: 'string', description: 'Só achados deste arquivo (relativo ao projeto) ou dos arquivos que começam com ele.' },
      code: { type: 'string', description: 'Só achados desta regra.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_FINDINGS, description: `Padrão: 50, até ${MAX_FINDINGS}.` }
    }
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async call(args, ctx) {
    const [{ lintWorkspace }, { RulesetError }] = await Promise.all([import('../lint'), import('@vvpost/core/lint')])
    let result
    try {
      result = await lintWorkspace(ctx.workspaceDir)
    } catch (err) {
      if (err instanceof RulesetError) throw new ToolError(err.message, { code: 'INVALID_RULESET', hint: 'corrija o .vvpost/ruleset.yaml (docs/lint.md) e chame de novo' })
      throw err
    }
    lastSeen.set(ctx.workspaceDir, new Set(result.findings.map(keyOf)))
    const level = LEVELS.indexOf((args['severity'] as LintSeverity | undefined) ?? 'hint')
    const file = args['file'] as string | undefined
    const code = args['code'] as string | undefined
    const limit = (args['limit'] as number | undefined) ?? 50
    const matching = result.findings.filter(
      (f) => LEVELS.indexOf(f.severity) <= level && (!file || f.file === file || f.file.startsWith(file)) && (!code || f.code === code)
    )
    return {
      ruleset: result.ruleset ?? 'vvpost:recommended',
      summary: result.summary,
      total: matching.length,
      findings: matching.slice(0, limit).map((f) => forAgent(f, ctx)),
      ...(matching.length > limit && { truncated: true }),
      ...(result.issues.length && { rulesetIssues: result.issues })
    }
  }
}

/**
 * Depois de uma escrita: os achados de erro e aviso que não estavam na última leitura (na primeira
 * escrita, os primeiros cinco), e a contagem. Lint quebrado não derruba a escrita.
 */
export async function lintAfterWrite(ctx: ToolContext): Promise<Record<string, unknown> | undefined> {
  let result
  try {
    result = await (await import('../lint')).lintWorkspace(ctx.workspaceDir)
  } catch {
    return undefined
  }
  const before = lastSeen.get(ctx.workspaceDir)
  lastSeen.set(ctx.workspaceDir, new Set(result.findings.map(keyOf)))
  const relevant = result.findings.filter((f) => f.severity === 'error' || f.severity === 'warn')
  const fresh = before ? relevant.filter((f) => !before.has(keyOf(f))) : relevant
  if (!fresh.length) return { lint: { summary: result.summary } }
  return {
    lint: {
      summary: result.summary,
      [before ? 'new' : 'findings']: fresh.slice(0, AFTER_WRITE_FINDINGS).map((f) => forAgent(f, ctx)),
      ...(fresh.length > AFTER_WRITE_FINDINGS && { more: fresh.length - AFTER_WRITE_FINDINGS }),
      hint: 'achados do lint (estilo e completude, não bloqueiam): corrija junto com a mudança quando fizer sentido; lint_project lista todos'
    }
  }
}

export const LINT_TOOLS: readonly McpTool[] = [lintProject]
