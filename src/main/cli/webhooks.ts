import type { CoreSession } from '@vvpost/core/session'
import type { SecretSanitizer } from '@vvpost/core/sanitizer'
import type { WebhookEvent } from '@vvpost/core/types'
import type { RunningWebhookServer } from '../webhooks/server'
import type { WebhookInbox } from '../webhooks/inbox'

const SIGNATURE_LABEL: Record<NonNullable<WebhookEvent['signature']>, string> = {
  valid: 'assinatura válida',
  invalid: 'assinatura inválida',
  missing: 'sem assinatura',
  unconfigured: 'chave da assinatura sem valor'
}

const FINAL = new Set(['passed', 'failed', 'error', 'skipped'])

/**
 * Servidor de webhooks sob demanda do `vvpost run`: só liga quando um fluxo tem nó webhook,
 * sem disparos (quem espera os eventos são os próprios nós), e fecha no fim da execução.
 */
export function lazyWebhookServer(
  workspaceDir: string,
  options: { port?: number; workspace: () => ReturnType<CoreSession['load']>; log?: (line: string) => void }
) {
  let starting: Promise<RunningWebhookServer> | undefined
  return {
    inbox: async (): Promise<WebhookInbox> => {
      starting ??= import('../webhooks/server').then((m) =>
        m.startWebhookServer(workspaceDir, { ...(options.port !== undefined && { port: options.port }), workspace: options.workspace }).then((server) => {
          options.log?.(`Webhooks em ${server.url}: os nós webhook dos fluxos esperam os eventos aqui`)
          return server
        })
      )
      return (await starting).inbox
    },
    url: async () => (starting ? (await starting.catch(() => null))?.url ?? null : null),
    close: async () => {
      await (await starting?.catch(() => null))?.close()
    }
  }
}

/** Uma linha por evento no terminal; com --json, um objeto por linha (NDJSON). */
function eventLine(e: WebhookEvent, json: boolean): string {
  if (json) {
    const { headers: _h, body: _b, bodyBase64: _b64, ...summary } = e
    return JSON.stringify(summary)
  }
  const parts = [`#${e.id}`, e.method, e.url, String(e.response.status)]
  if (e.hookId) parts.push(`hook ${e.hookId}`)
  if (e.signature) parts.push(SIGNATURE_LABEL[e.signature])
  if (e.rejected) parts.push(`recusado: ${e.rejected}`)
  return parts.join('  ')
}

function triggerLine(e: WebhookEvent): string {
  const t = e.trigger!
  const what = t.kind === 'flow' ? `fluxo ${t.target}` : `cenários de ${t.target}`
  return `#${e.id}  ${what}${t.environmentId ? ` em ${t.environmentId}` : ''}: ${t.status}${t.message ? ` (${t.message})` : ''}${t.durationMs !== undefined ? `  ${t.durationMs} ms` : ''}`
}

/**
 * `vvpost webhooks`: o servidor local de webhooks sem o app, até o Ctrl+C. Cada
 * evento sai numa linha (sanitizada), e os hooks com trigger rodam o fluxo ou os cenários
 * pelo motor, com os limites de disparo sem humano e a mesma revisão do MCP.
 */
export async function serveWebhooks(
  core: CoreSession,
  sanitizer: SecretSanitizer,
  io: { stdout: (t: string) => void; stderr: (t: string) => void; signal?: AbortSignal },
  options: { port?: number; environment?: string; json: boolean }
): Promise<number> {
  const [{ startWebhookServer }, { createTriggerQueue, runTrigger }, { createWebhookInbox }, { loadWebhooksConfig }, policy] = await Promise.all([
    import('../webhooks/server'),
    import('../webhooks/triggers'),
    import('../webhooks/inbox'),
    import('../webhooks/config'),
    import('@vvpost/core/policy/request-policy')
  ])
  const inbox = createWebhookInbox({ maxEvents: (await loadWebhooksConfig(core.workspaceDir)).maxEvents })
  const guard = policy.createRequestGuard({ actor: 'um webhook', ...policy.WEBHOOK_POLICY_DEFAULTS })
  const out = (line: string) => io.stdout(`${sanitizer.text(line)}\n`)
  // Com a máscara para pessoas ligada, a URL e a query do evento saem sem os dados pessoais.
  const [ws, { peopleMasker }, { featureDenial }, view] = await Promise.all([
    core.load(),
    import('@vvpost/core/pii'),
    import('@vvpost/core/policy/features'),
    import('@vvpost/core/pii-people')
  ])
  const pii = await peopleMasker(ws, [ws.dir, ...(ws.root ? [ws.root] : [])], featureDenial('piiVisible') !== null)
  const shown = (e: WebhookEvent) => (pii ? view.peopleWebhookEvent(e, pii) : e)
  const reported = new Set<number>()
  const unsubscribe = inbox.subscribe((change, event) => {
    if (!event) return
    if (change === 'added') out(eventLine(shown(sanitizer.sanitize(event)), options.json))
    else if (event.trigger && FINAL.has(event.trigger.status) && !reported.has(event.id)) {
      reported.add(event.id)
      out(options.json ? JSON.stringify({ id: event.id, trigger: sanitizer.sanitize(event.trigger) }) : triggerLine(event))
    }
  })

  let triggers: ReturnType<typeof createTriggerQueue> | null = null
  const server = await startWebhookServer(core.workspaceDir, {
    ...(options.port !== undefined && { port: options.port }),
    ...(options.environment !== undefined && { environment: options.environment }),
    inbox,
    workspace: () => core.load(),
    onTrigger: (event, hook) => triggers?.enqueue(event, hook)
  })
  triggers = createTriggerQueue({
    inbox,
    environment: server.environment,
    run: async (job, signal) => {
      const { report: _, ...outcome } = await runTrigger(
        job,
        {
          workspaceDir: core.workspaceDir,
          loadWorkspace: () => core.load(),
          loadFlows: () => core.loadFlows(),
          runFlow: (input, ws, opts) => core.runFlow(input, ws, { signal: opts.signal, webhookSince: opts.webhookSince, guard, webhooks: async () => inbox }),
          runScenarios: (input, ws, s) => core.runScenarios(input, ws, s, guard)
        },
        signal
      )
      return outcome
    }
  })

  const hooks = server.config.hooks
  io.stderr(
    [
      `Webhooks em ${server.url} (workspace ${core.workspaceDir}${server.environment ? `, ambiente ${server.environment}` : ''})`,
      ...(hooks.length
        ? hooks.map((h) => `  ${h.path}  ${h.id}${h.trigger ? `  → ${h.trigger.flow !== undefined ? `fluxo ${h.trigger.flow}` : `cenários de ${h.trigger.connector}`}` : ''}`)
        : ['  sem .vvpost/webhooks.json: aceita qualquer caminho e responde 200']),
      'Ctrl+C para sair.',
      ''
    ].join('\n')
  )

  await new Promise<void>((done) => {
    if (!io.signal || io.signal.aborted) return done()
    io.signal.addEventListener('abort', () => done(), { once: true })
  })
  triggers.close()
  unsubscribe()
  await server.close()
  return 0
}
