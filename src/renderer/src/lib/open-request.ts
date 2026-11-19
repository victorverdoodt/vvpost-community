import type { Flow, HttpHeader, HttpMethod, RequestPayload, RequestScripts } from '@shared/ipc'
import type { SimpleKeep } from '@vvpost/core/flows/simple-flow'
import { track } from './ux-study'

/** Requisição para abrir numa aba nova do Quick Request (histórico, catálogo, testes). */
export interface OpenRequest {
  method: HttpMethod
  url: string
  headers: HttpHeader[]
  body: string
  connectorId: string | null
  environmentId: string | null
  /** Endpoint do conector que a aba representa (catálogo, testes). */
  endpointId?: string | null
  /** Fluxo de preparação que roda antes do envio (histórico). */
  prepareFlowId?: string | null
  /** Scripts pre e post da própria requisição (histórico). */
  scripts?: RequestScripts
  /** Nova requisição (Ctrl+N): fica no conector e no ambiente que já estão escolhidos. */
  keepContext?: boolean
  /** Corpo estruturado (form, multipart, binário), no lugar de body. */
  payload?: RequestPayload
  /** O fluxo de um nó que a requisição é (visão Simples): Ctrl+S grava nele. */
  flow?: FlowRef
}

/** O arquivo de fluxo por trás de uma aba do Quick Request. */
export interface FlowRef {
  id: string
  name: string
  file?: string
  /** Versão do arquivo de quando a aba abriu ou salvou: salvar recusa se alguém (a IA) gravou no meio. */
  version?: string | null
  /** draftSignature do que está no disco, para saber se a aba tem mudança não salva. */
  saved: string
  /** Os nós anteriores à requisição: rodam em segundo plano antes do envio, como a preparação. */
  before?: Flow | null
  /** O nó da requisição (id, nome, posição) e os nós de antes ligados a ele: voltam iguais ao salvar. */
  node?: { id: string; name: string; position?: { x: number; y: number } }
  incoming?: string[]
  /** O que a aba não edita e volta ao arquivo ao salvar. */
  keep?: { timeoutMs?: number; followRedirects?: boolean; description?: string; inherit?: SimpleKeep }
}

/** O App troca para o Quick Request; o módulo, montado ou não, pega a requisição pendente. */
export const OPEN_REQUEST = 'vvpost:open-request'

let pending: OpenRequest | null = null

/** `from` diz de onde veio, para o teste com usuários (continuidade entre módulos). */
export function openInQuickRequest(request: OpenRequest, from: 'history' | 'scenario' | 'flow' | 'docs' | 'explorer' = 'history'): void {
  track('open-in-quick', { from })
  pending = request
  window.dispatchEvent(new Event(OPEN_REQUEST))
}

export function takePendingRequest(): OpenRequest | null {
  const request = pending
  pending = null
  return request
}

/** Ctrl+L e Ctrl+N: foco no campo de URL da aba ativa, também com o módulo ainda montando. */
export const FOCUS_URL = 'vvpost:focus-url'
let focusPending = false

export function focusQuickRequestUrl(): void {
  focusPending = true
  window.dispatchEvent(new Event(FOCUS_URL))
}

export function takeUrlFocus(): boolean {
  const pending = focusPending
  focusPending = false
  return pending
}
