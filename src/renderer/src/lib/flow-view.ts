import type { Flow } from '@shared/ipc'
import { splitFlow } from '@vvpost/core/flows/simple-flow'
import { flowSignature } from '../modules/quick-request/draft'
import { openInQuickRequest } from './open-request'

/**
 * Requisição e fluxo são o mesmo documento: um fluxo que termina num nó de requisição abre na
 * visão Simples (Quick Request), com os nós anteriores rodando em segundo plano antes do envio, e
 * volta à Canvas (Flow Studio). `saved` é o fluxo como está no disco (null: ainda não salvo),
 * para a aba saber se tem mudança. false quando o fluxo não cabe na visão Simples.
 */
export function openFlowAsRequest(flow: Flow, options: { file?: string; version?: string | null; saved?: Flow | null } = {}, from: 'flow' | 'explorer' = 'flow'): boolean {
  const split = splitFlow(flow)
  if (!split) return false
  const { request: req } = split
  const saved = options.saved === undefined ? split : options.saved && splitFlow(options.saved)
  openInQuickRequest(
    {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: req.body ?? '',
      ...(req.payload && { payload: req.payload }),
      connectorId: req.connector ?? null,
      environmentId: null,
      endpointId: req.endpoint ?? null,
      ...(req.scripts && { scripts: req.scripts }),
      flow: {
        id: flow.id,
        name: flow.name,
        ...(options.file && { file: options.file }),
        ...(options.version !== undefined && { version: options.version }),
        saved: saved ? flowSignature(saved.request, '', saved.before) : '',
        before: split.before,
        node: split.node,
        incoming: split.incoming,
        keep: {
          ...(req.timeoutMs !== undefined && { timeoutMs: req.timeoutMs }),
          ...(req.followRedirects !== undefined && { followRedirects: req.followRedirects }),
          ...(flow.description && { description: flow.description }),
          ...((split.keep.flow || split.keep.request) && { inherit: split.keep })
        }
      }
    },
    from
  )
  return true
}
