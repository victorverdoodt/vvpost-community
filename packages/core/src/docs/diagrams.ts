import type { ConnectorAuth, Flow } from '@vvpost/schemas'
import { describeAuth } from '../connectors/summary'

/** Texto seguro dentro de um rótulo Mermaid entre aspas. */
export function label(text: string): string {
  return text
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;')
    .replace(/\{/g, '#123;')
    .replace(/\}/g, '#125;')
    .replace(/[\r\n]+/g, ' ')
}

/** Texto seguro numa mensagem ou nome de participante de sequenceDiagram (sem ; e # que a sintaxe usa). */
export function message(text: string): string {
  return text.replace(/#/g, '#35;').replace(/;/g, '#59;').replace(/[\r\n]+/g, ' ')
}

/** Máximo de cenários desenhados como ramos no diagrama de sequência; o resto fica só no texto. */
const MAX_SEQUENCE_BRANCHES = 8

/**
 * Sequência de uma chamada ao endpoint com a auth headless: o token (quando há fluxo de
 * auth) e a requisição, com um ramo por cenário e o status que cada um espera.
 */
export function endpointSequence(input: {
  connectorName: string
  chain: string[]
  method: string
  /** Caminho com o basePath herdado (a URL sem a baseUrl). */
  path: string
  auth?: { config: Exclude<ConnectorAuth, { type: 'none' }>; fromName: string }
  scenarios: { name: string; expectedStatus?: number }[]
}): string {
  const lines = ['sequenceDiagram', '  autonumber', '  participant C as HttpClient']
  const auth = input.auth?.config
  if (auth?.type === 'oauth2') lines.push('  participant T as Token endpoint')
  if (auth?.type === 'login') lines.push('  participant L as Login')
  lines.push(`  participant API as ${message(input.connectorName)}`)
  if (input.chain.length > 1) lines.push(`  Note over C: herança ${message(input.chain.join(' → '))}`)
  if (auth?.type === 'oauth2') {
    lines.push('  opt sem token em memória ou expirado')
    lines.push(`    C->>T: POST ${message(auth.tokenUrl)} (grant_type=${auth.grantType})`)
    lines.push('    T-->>C: access_token, expires_in')
    lines.push('  end')
  } else if (auth?.type === 'login') {
    lines.push('  opt sem token em memória ou expirado')
    lines.push(`    C->>L: ${auth.request.method ?? 'POST'} ${message(auth.request.url)}`)
    lines.push(`    L-->>C: token em ${message(auth.token)}`)
    lines.push('  end')
  }
  const credential = !auth
    ? ''
    : auth.type === 'oauth2'
      ? ' + Authorization com o access_token'
      : auth.type === 'login'
        ? ` + ${auth.inject?.in === 'query' ? 'query' : 'header'} ${auth.inject?.name ?? 'Authorization'}`
        : ` + ${describeAuth(auth)}`
  lines.push(`  C->>API: ${input.method} ${message(input.path)}${message(credential)}`)
  const branches = input.scenarios.slice(0, MAX_SEQUENCE_BRANCHES)
  if (branches.length === 0) {
    lines.push('  API-->>C: resposta')
  } else {
    branches.forEach((s, i) => {
      lines.push(`  ${i === 0 ? 'alt' : 'else'} ${message(s.name)}`)
      lines.push(`    API-->>C: ${s.expectedStatus !== undefined ? `HTTP ${s.expectedStatus}` : 'resposta conferida pelas asserções'}`)
    })
    lines.push('  end')
    if (input.scenarios.length > branches.length) {
      lines.push(`  Note over C,API: mais ${input.scenarios.length - branches.length} cenário(s) no texto`)
    }
  }
  return lines.join('\n')
}

/**
 * O grafo do fluxo, com os nós que chamam o endpoint (ou o conector) em destaque. Cada
 * nó mostra o nome e o que faz; arestas de condição levam o ramo.
 */
export function flowDiagram(flow: Flow, highlight: ReadonlySet<string>): string {
  const ids = new Map(flow.nodes.map((n, i) => [n.id, `n${i}`]))
  const lines = ['graph LR']
  for (const node of flow.nodes) {
    let what = ''
    if (node.type === 'request') {
      const r = node.request
      what = r.endpoint ? `${r.connector ?? ''}/${r.endpoint}` : `${r.method ?? 'GET'} ${r.url ?? ''}`
    } else if (node.type === 'condition') {
      what = `${node.failWhenFalse ? 'exige' : 'se'} ${node.condition.target} ${node.condition.operator}`
    } else if (node.type === 'python') {
      what = 'Python'
    } else if (node.type === 'wait') {
      what = `espera ${node.wait.ms} ms`
    } else if (node.type === 'webhook') {
      const w = node.webhook
      what = `webhook ${[w.method, w.hook, w.path].filter(Boolean).join(' ') || '(qualquer)'}`
    } else if (node.type === 'oauth2') {
      what = `OAuth2 ${node.oauth2.grantType}`
    } else {
      what = node.plugin.node ?? `adapter ${node.plugin.adapter ?? ''}`
    }
    const text = `${label(node.name)}<br/>${label(what.trim())}`
    lines.push(node.type === 'condition' ? `  ${ids.get(node.id)}{"${text}"}` : `  ${ids.get(node.id)}["${text}"]`)
  }
  for (const edge of flow.edges ?? []) {
    const from = ids.get(edge.from)
    const to = ids.get(edge.to)
    if (!from || !to) continue
    lines.push(edge.branch ? `  ${from} -- ${edge.branch === 'true' ? 'sim' : 'não'} --> ${to}` : `  ${from} --> ${to}`)
  }
  const marked = flow.nodes.filter((n) => highlight.has(n.id)).map((n) => ids.get(n.id))
  if (marked.length) lines.push(`  class ${marked.join(',')} current`)
  lines.push('  classDef current stroke:#8b7cff,stroke-width:3px')
  return lines.join('\n')
}

/** Endpoints a partir dos quais o mapa do projeto mostra só a contagem por conector. */
const MAX_MAP_ENDPOINTS = 40

/**
 * Mapa do projeto: a herança entre os conectores, os endpoints de cada um (ou a contagem,
 * em projetos grandes) e os fluxos ligados aos conectores que chamam.
 */
export function projectMap(input: {
  connectors: { id: string; name: string; extends?: string; endpoints: { id: string; method: string; path: string }[] }[]
  flows: { id: string; name: string; connectors: string[] }[]
}): string {
  const lines = ['graph LR']
  const cid = new Map(input.connectors.map((c, i) => [c.id, `c${i}`]))
  const total = input.connectors.reduce((n, c) => n + c.endpoints.length, 0)
  const detailed = total <= MAX_MAP_ENDPOINTS
  for (const c of input.connectors) {
    const count = detailed || c.endpoints.length === 0 ? '' : `<br/>${c.endpoints.length} endpoint(s)`
    lines.push(`  ${cid.get(c.id)}["${label(c.name)}${count}"]:::connector`)
  }
  for (const c of input.connectors) {
    if (c.extends && cid.has(c.extends)) lines.push(`  ${cid.get(c.extends)} -->|herda| ${cid.get(c.id)}`)
  }
  if (detailed) {
    input.connectors.forEach((c, i) => {
      c.endpoints.forEach((e, j) => {
        lines.push(`  e${i}_${j}["${label(`${e.method} ${e.path}`)}"]:::endpoint`)
        lines.push(`  ${cid.get(c.id)} --- e${i}_${j}`)
      })
    })
  }
  input.flows.forEach((f, i) => {
    lines.push(`  f${i}(["${label(f.name)}"]):::flow`)
    for (const c of f.connectors) if (cid.has(c)) lines.push(`  f${i} -.->|usa| ${cid.get(c)}`)
  })
  lines.push('  classDef connector stroke:#8b7cff,stroke-width:2px')
  lines.push('  classDef endpoint stroke:#6aa9ff')
  lines.push('  classDef flow stroke:#39c69a,stroke-dasharray:4 3')
  return lines.join('\n')
}

/** Texto curto para a descrição de um elemento C4. */
const brief = (text: string, max = 70) => (text.length > max ? `${text.slice(0, max - 3)}...` : text)

/**
 * C4 de contexto gerado do catálogo ({{> c4}}): o projeto, os conectores (dentro da fronteira do
 * conector-base de que herdam) e uma relação do projeto com cada um, com o nome dos fluxos que o
 * chamam. Sai a cada montagem, então não envelhece; o C4 escrito à mão o lint compara com o catálogo.
 */
export function c4Context(input: {
  projectName: string
  connectors: { id: string; name: string; description?: string; extends?: string; endpoints: number }[]
  flows: { name: string; connectors: string[] }[]
}): string {
  const lines = ['C4Context', `  title ${label(`Integrações de ${input.projectName}`)}`, `  System(projeto, "${label(input.projectName)}", "Chama as APIs do catálogo")`]
  const ids = new Set(input.connectors.map((c) => c.id))
  const children = new Map<string, typeof input.connectors>()
  for (const c of input.connectors) {
    const parent = c.extends && ids.has(c.extends) && c.extends !== c.id ? c.extends : ''
    children.set(parent, [...(children.get(parent) ?? []), c])
  }
  const alias = new Map(input.connectors.map((c, i) => [c.id, `c${i}`]))
  const drawn = new Set<string>()
  const draw = (c: (typeof input.connectors)[number], indent: string) => {
    if (drawn.has(c.id)) return
    drawn.add(c.id)
    const kids = children.get(c.id) ?? []
    const text = c.description ? brief(c.description) : `${c.endpoints} endpoint(s)`
    if (!kids.length) {
      lines.push(`${indent}System_Ext(${alias.get(c.id)}, "${label(c.name)}", "${label(text)}")`)
      return
    }
    lines.push(`${indent}Enterprise_Boundary(b${alias.get(c.id)!.slice(1)}, "${label(c.name)}") {`)
    if (c.endpoints > 0) lines.push(`${indent}  System_Ext(${alias.get(c.id)}, "${label(c.name)}", "${label(text)}")`)
    for (const k of kids) draw(k, `${indent}  `)
    lines.push(`${indent}}`)
  }
  for (const c of children.get('') ?? []) draw(c, '  ')
  // Ciclo de herança (o validate acusa): o que sobrou sai solto.
  for (const c of input.connectors) draw(c, '  ')
  for (const c of input.connectors) {
    if (c.endpoints === 0 && (children.get(c.id)?.length ?? 0) > 0) continue
    const by = input.flows.filter((f) => f.connectors.includes(c.id)).map((f) => f.name)
    const text = by.length ? brief(by.join(', '), 60) : 'Chama'
    lines.push(`  Rel(projeto, ${alias.get(c.id)}, "${label(text)}", "HTTPS")`)
  }
  return lines.join('\n')
}
