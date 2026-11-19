import { isProtectedEnvironment } from '@vvpost/core/policy/protected'
import { readReviewMarks } from '../project/review'
import { load, ToolError, type McpTool } from './tools'

/**
 * `check_readiness` (docs/readiness.md): o que impede o projeto de rodar, por ambiente e de uma vez,
 * antes do primeiro execute_dry_run. Soma ao relatório do motor o que limita só a IA: ambiente
 * protegido, --allow-env, --read-only e conector ou fluxo esperando a revisão do usuário.
 */

const checkReadiness: McpTool = {
  name: 'check_readiness',
  title: 'Conferir se o projeto consegue rodar, antes de testar',
  description:
    'Todos os bloqueios de uma vez, por ambiente: segredo sem valor, variável que o ambiente não define, URL inválida, API que não abre conexão (só TCP, nada é enviado) e o que limita a IA (ambiente protegido, revisão pendente). ' +
    'Chame antes do primeiro execute_dry_run ou execute_flow, e quando um deles falhar sem motivo claro.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      environmentIds: { type: 'array', items: { type: 'string' }, description: 'Só estes ambientes. Padrão: todos.' },
      probe: { type: 'boolean', description: 'false: não abre conexão com as APIs. Padrão: true.' }
    }
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async call(args, ctx) {
    const ws = await load(ctx)
    const environmentIds = Array.isArray(args['environmentIds']) ? (args['environmentIds'] as string[]) : undefined
    for (const id of environmentIds ?? []) {
      if (!ws.environments.has(id)) throw new ToolError(`ambiente "${id}" não existe no workspace`, { code: 'NOT_FOUND', hint: `ambientes: ${[...ws.environments.keys()].join(', ') || '(nenhum)'}` })
    }
    const { checkReadiness: check } = await import('@vvpost/core/readiness')
    const report = await check(ws, {
      ...(environmentIds && { environmentIds }),
      probe: args['probe'] !== false,
      proxy: { mode: 'env' }
    })

    // O que só a IA não pode: o usuário, no app ou no CLI, roda normalmente.
    const marks = await readReviewMarks(ctx.workspaceDir)
    for (const key of Object.keys(marks).sort()) {
      const flow = key.startsWith('flow:') ? key.slice('flow:'.length) : undefined
      report.workspace.push({
        code: 'review-pending',
        severity: 'agent',
        ...(flow ? {} : { connector: key }),
        message: flow
          ? `o fluxo ${flow} tem código ainda não revisado: a IA só roda com plan: true`
          : `${key} teve auth, destino ou credenciais alterados pela IA e não foi revisado: a IA só roda com plan: true`,
        hint: ctx.centralReview ? 'quem aprova é o console do Control Plane' : 'o usuário revisa no app (salvar o conector no Catálogo) ou com vvpost-mcp --approve-review'
      })
    }
    if (ctx.readOnly) report.workspace.push({ code: 'read-only', severity: 'agent', message: 'o servidor MCP está em modo somente leitura: a IA só monta as requisições (plan)' })
    const environments = report.environments.map((env) => {
      const e = ws.environments.get(env.id)
      if (e && (isProtectedEnvironment(e) || ctx.protectedEnvironments?.has(e.id))) {
        env.findings.push({ code: 'protected', severity: 'agent', message: `"${env.id}" é ambiente protegido (produção): a IA só monta e valida`, hint: 'o disparo é do usuário, no app' })
      } else if (ctx.allowEnvironments && !ctx.allowEnvironments.has(env.id)) {
        env.findings.push({ code: 'not-allowed', severity: 'agent', message: `o servidor MCP não deixa a IA disparar em ${env.id ? `"${env.id}"` : '(sem ambiente)'} (--allow-env)` })
      }
      const agentCanExecute = env.canExecute && !ctx.readOnly && !env.findings.some((f) => f.severity === 'agent')
      return { ...env, agentCanExecute }
    })
    const blockers = [...report.workspace, ...report.environments.flatMap((e) => e.findings)].filter((f) => f.severity === 'blocker').length
    return ctx.sanitizer.sanitize({
      ...report,
      environments,
      hint: report.ready
        ? 'pronto: rode os cenários com execute_dry_run'
        : `${blockers} bloqueio(s): resolva o hint de cada um antes de rodar; um cenário que falha agora falharia por isso, não pelo código`
    })
  }
}

export const READINESS_TOOLS: readonly McpTool[] = [checkReadiness]
