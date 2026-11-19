import { BookmarkPlus, ClipboardPaste, Code, Copy, CopyPlus, FlaskConical, Network, Send, Terminal } from 'lucide-react'
import type { CatalogConnector, ProjectEdit } from '@shared/ipc'
import type { ResponseExample, Scenario } from '@vvpost/schemas'
import { formatShortcut, separator, Shortcut, type ContextMenuEntries } from '../../design-system'
import { freeId } from '../../lib/clipboard'
import { CODE_TARGET_LABEL, toCode, type CodeTarget, type RequestSnapshot } from '../../lib/request-code'
import { activeHeaders, draftPayload, parseQuery, type RequestDraft } from './draft'

const icon = { size: 14, 'aria-hidden': true } as const

/** URL completa: a baseUrl do conector antes de um caminho relativo. */
export function fullUrl(url: string, connector: CatalogConnector | null): string {
  const u = url.trim()
  if (!connector?.baseUrl || /^[a-z][a-z0-9+.-]*:\/\//i.test(u) || u.startsWith('{{')) return u
  return `${connector.baseUrl.replace(/\/+$/, '')}/${u.replace(/^\/+/, '')}`
}

/**
 * A requisição como vai no envio, sem a auth do conector: headers herdados (os locais
 * com o mesmo nome substituem) e os da aba.
 */
export function snapshotOf(d: RequestDraft, connector: CatalogConnector | null): RequestSnapshot {
  const local = activeHeaders(d)
  const names = new Set(local.map((h) => h.name.trim().toLowerCase()))
  const inherited = (connector?.headers ?? []).filter((h) => !names.has(h.name.toLowerCase()))
  return {
    method: d.method,
    url: fullUrl(d.url, connector),
    headers: [...inherited, ...local],
    ...(draftPayload(d) ? { payload: draftPayload(d) } : d.body && { body: d.body })
  }
}

export interface RequestActions {
  send: () => void
  duplicate: () => void
  pasteCurl: () => void
  copy: (text: string, what: string) => void
  generateScenario: () => void
  saveExample: () => void
  openConnector?: () => void
}

/** Itens da requisição: no menu da aba, da barra de URL e na Command Palette. */
export function requestEntries(
  d: RequestDraft,
  connector: CatalogConnector | null,
  actions: RequestActions,
  options: { forPalette?: boolean } = {}
): ContextMenuEntries {
  const snap = () => snapshotOf(d, connector)
  // Uma aba de protocolo de plugin (gRPC, Kafka...) não é HTTP: não há URL, cURL nem código para copiar.
  // Uma conexão realtime tem URL, mas não vira cURL nem código.
  const hasUrl = !d.adapter && !!d.url.trim()
  const asCode = hasUrl && !d.realtime
  const canSend = d.adapter ? true : hasUrl
  const live = d.live?.status === 'open' || d.live?.status === 'connecting'
  const copyAs = (target: CodeTarget) => () =>
    actions.copy(toCode(target, snap()), `${CODE_TARGET_LABEL[target]} copiado${connector?.auth ? ' (sem a auth do conector)' : ''}`)
  return [
    {
      id: 'send',
      label: d.realtime ? (live ? 'Desconectar' : 'Conectar') : 'Enviar',
      icon: <Send {...icon} />,
      // Ctrl+Enter já é da barra de execução: aqui só aparece.
      hint: formatShortcut(Shortcut.run),
      keywords: ['testar', 'endpoint', 'executar', 'request'],
      disabled: !canSend || !!d.pendingId,
      run: actions.send
    },
    { id: 'duplicate', label: 'Duplicar em nova aba', icon: <CopyPlus {...icon} />, shortcut: Shortcut.duplicate, run: actions.duplicate },
    separator,
    {
      id: 'copy-url',
      label: 'Copiar URL',
      icon: <Copy {...icon} />,
      disabled: !hasUrl,
      run: () => actions.copy(fullUrl(d.url, connector), 'URL copiada')
    },
    {
      id: 'copy-curl',
      label: 'Copiar como cURL',
      icon: <Terminal {...icon} />,
      shortcut: Shortcut.copyAsCurl,
      disabled: !asCode,
      run: copyAs('curl')
    },
    {
      id: 'copy-code',
      label: 'Copiar como código',
      icon: <Code {...icon} />,
      disabled: !asCode,
      items: (['fetch', 'python', 'httpie'] as const).map((t) => ({ id: `code-${t}`, label: CODE_TARGET_LABEL[t], run: copyAs(t) }))
    },
    {
      id: 'paste-curl',
      label: options.forPalette ? 'Colar cURL na requisição' : 'Colar cURL como requisição',
      icon: <ClipboardPaste {...icon} />,
      run: actions.pasteCurl
    },
    separator,
    {
      id: 'scenario',
      label: d.endpointId ? 'Gerar cenário de teste a partir da request' : 'Gerar cenário de teste (escolha um endpoint)',
      icon: <FlaskConical {...icon} />,
      disabled: !d.endpointId || !connector,
      run: actions.generateScenario
    },
    {
      id: 'example',
      label: d.endpointId ? 'Salvar a resposta como exemplo do endpoint' : 'Salvar a resposta como exemplo (escolha um endpoint)',
      icon: <BookmarkPlus {...icon} />,
      keywords: ['mock', 'exemplo', 'resposta'],
      disabled: !d.endpointId || !connector || !d.result?.ok || !!d.adapter || !!d.realtime,
      run: actions.saveExample
    },
    actions.openConnector && { id: 'open-connector', label: 'Abrir o conector no Catálogo', icon: <Network {...icon} />, run: actions.openConnector }
  ]
}

/**
 * Exemplo de resposta a partir da última resposta da aba, para o mock server: status, o
 * Content-Type (os outros headers ficam de fora, porque Set-Cookie e afins carregam sessão) e o
 * corpo, como JSON quando dá. Resposta cortada não vira exemplo.
 */
export function exampleFromDraft(d: RequestDraft, connector: CatalogConnector): Extract<ProjectEdit, { op: 'upsertExample' }> | string {
  const endpoint = connector.endpoints.find((e) => e.id === d.endpointId)
  if (!endpoint) return 'Escolha o endpoint da requisição para salvar o exemplo.'
  if (!d.result?.ok) return 'Envie a requisição: o exemplo é a última resposta.'
  const res = d.result.response
  if (res.truncated) return 'A resposta foi cortada pelo limite de tamanho; não dá para salvar como exemplo.'
  if (res.bodyBase64) return 'Resposta binária não vira exemplo (o mock serve texto ou JSON).'
  const type = res.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value
  let body: unknown = res.body
  if (res.body && (/json/i.test(type ?? '') || /^\s*[[{]/.test(res.body))) {
    try {
      body = JSON.parse(res.body)
    } catch {
      // Fica como texto.
    }
  }
  const taken = (endpoint.examples ?? []).map((e) => e.id)
  const example: ResponseExample = {
    id: freeId(`${res.status >= 200 && res.status < 300 ? 'ok' : 'erro'}-${res.status}`, taken),
    name: `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
    status: res.status,
    ...(type && { headers: { 'Content-Type': type } }),
    ...(res.body !== '' && { body })
  }
  return { op: 'upsertExample', connectorId: connector.id, endpointId: endpoint.id, example }
}

/** Casa o caminho concreto com o modelo do endpoint (/charges/{id} ← /charges/42). */
function matchPath(template: string, path: string): Record<string, string> | null {
  const names: string[] = []
  const source = template
    .split(/(\{[A-Za-z0-9_]+\})/)
    .map((part) => {
      const m = /^\{([A-Za-z0-9_]+)\}$/.exec(part)
      if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      names.push(m[1]!)
      return '([^/]+)'
    })
    .join('')
  const match = new RegExp(`^${source}$`).exec(path)
  if (!match) return null
  return Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(match[i + 1]!)]))
}

/**
 * Cenário de teste a partir da aba: o que difere do endpoint vira override (corpo, headers,
 * query, parâmetros de rota) e o status da última resposta vira a asserção.
 */
export function scenarioFromDraft(d: RequestDraft, connector: CatalogConnector): ProjectEdit | null {
  const endpoint = connector.endpoints.find((e) => e.id === d.endpointId)
  if (!endpoint) return null
  const overrides: NonNullable<Scenario['overrides']> = {}
  if (endpoint.plugin) {
    if (d.adapter !== endpoint.plugin.adapter) return null
    // Endpoint de plugin: o que mudou na config vira overrides.config (null tira um campo do endpoint).
    const base = endpoint.plugin.config ?? {}
    const now = d.pluginConfig ?? {}
    const config: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(now)) if (JSON.stringify(value) !== JSON.stringify(base[key])) config[key] = value
    for (const key of Object.keys(base)) if (!Object.hasOwn(now, key)) config[key] = null
    if (Object.keys(config).length) overrides.config = config
    return scenarioOf(d, connector, endpoint, overrides)
  }
  const [path] = d.url.trim().split(/[?#]/)
  if (path && path !== endpoint.path) {
    const params = matchPath(endpoint.path, path)
    if (params && Object.keys(params).length) overrides.pathParams = params
  }
  const query = parseQuery(d.url)
  if (query.length) overrides.query = Object.fromEntries(query.map((q) => [q.name, q.value]))
  const base = new Map(endpoint.headers.map((h) => [h.name.toLowerCase(), h.value]))
  const headers = activeHeaders(d).filter((h) => base.get(h.name.toLowerCase()) !== h.value)
  if (headers.length) overrides.headers = Object.fromEntries(headers.map((h) => [h.name, h.value]))
  const payload = d.method !== 'GET' && d.method !== 'HEAD' ? draftPayload(d) : undefined
  if (JSON.stringify(payload) !== JSON.stringify(endpoint.payload)) overrides.payload = payload ?? null
  if (!payload && d.method !== 'GET' && d.method !== 'HEAD' && d.body.trim() && d.body.trim() !== (endpoint.body ?? '').trim()) {
    try {
      overrides.body = JSON.parse(d.body)
    } catch {
      overrides.body = d.body
    }
  }
  return scenarioOf(d, connector, endpoint, overrides)
}

function scenarioOf(
  d: RequestDraft,
  connector: CatalogConnector,
  endpoint: CatalogConnector['endpoints'][number],
  overrides: NonNullable<Scenario['overrides']>
): ProjectEdit {
  const status = d.result?.ok ? d.result.response.status : 200
  const scenario: Scenario = {
    id: freeId(`request-status-${status}`, endpoint.scenarios.map((s) => s.id)),
    name: `Da request (status ${status})`,
    ...(Object.keys(overrides).length && { overrides }),
    assertions: [{ target: 'status', operator: 'equals', expected: status }]
  }
  return { op: 'upsertScenario', connectorId: connector.id, endpointId: endpoint.id, scenario }
}
