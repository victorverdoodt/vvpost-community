import type { ApiDocument, DocConnector, DocEndpoint, DocHeader, DocScenario } from './model'

/** Origem dos headers do próprio endpoint (igual a ENDPOINT_ORIGIN do build). */
const ENDPOINT_ORIGIN = '(endpoint)'

/**
 * O documento em Markdown (GFM), com os diagramas em blocos ```mermaid: abre no GitHub,
 * no GitLab, no Azure DevOps e em qualquer editor que renderiza Mermaid. É a mesma fonte
 * do PDF do app.
 */
export function renderDocMarkdown(doc: ApiDocument): string {
  const out: string[] = []
  const names = new Map(doc.connectors.flatMap((c) => c.chain.map((x) => [x.id, x.name] as const)))
  const name = (id: string) => names.get(id) ?? id

  out.push(`# ${doc.title}`, '')
  out.push(
    `> ${doc.scope.kind === 'project' ? 'Projeto' : `${doc.scopeLabel} do projeto`} **${escapeInline(doc.project.name)}** · gerado em ${formatDate(doc.generatedAt)} por ${escapeInline(doc.generator)}.`,
    '> Variáveis secretas aparecem só pelo nome: nenhum valor de segredo entra neste documento.',
    ''
  )

  // Sumário, com as âncoras no formato do GitHub (minúsculas, sem pontuação, repetidas ganham -1, -2...).
  const toc: string[] = []
  const headings: { level: number; text: string }[] = [{ level: 2, text: 'Projeto' }]
  for (const c of doc.connectors) {
    headings.push({ level: 2, text: connectorHeading(c) })
    for (const e of c.endpoints) headings.push({ level: 3, text: endpointHeading(e) })
  }
  if (doc.issues.length) headings.push({ level: 2, text: 'Avisos' })
  const tocSlugs = new Map<string, number>()
  for (const h of headings) {
    const base = slugBase(h.text)
    const n = tocSlugs.get(base) ?? 0
    tocSlugs.set(base, n + 1)
    toc.push(`${'  '.repeat(h.level - 2)}- [${escapeInline(h.text)}](#${n ? `${base}-${n}` : base})`)
  }
  out.push('## Sumário', '', ...toc, '')

  out.push(`## Projeto`, '')
  renderProject(doc, out, ['summary', 'map', 'environments', 'variables', 'flows'])

  for (const c of doc.connectors) renderConnector(c, out, name)

  if (doc.issues.length) {
    out.push('## Avisos', '')
    for (const i of doc.issues) out.push(`- ${code(i.file)}: ${escapeInline(i.message)}`)
    out.push('')
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

/** Partes da seção "Projeto" do documento, também usadas como trechos no documento do projeto. */
type ProjectPart = 'summary' | 'map' | 'c4' | 'environments' | 'variables' | 'flows'

function renderProject(doc: ApiDocument, out: string[], parts: ProjectPart[]) {
  const p = doc.project
  for (const part of parts) {
    if (part === 'summary') {
      out.push(
        '| Conectores | Endpoints | Requests (cenários) | Fluxos | Ambientes |',
        '| ---: | ---: | ---: | ---: | ---: |',
        `| ${p.connectors} | ${p.endpoints} | ${p.scenarios} | ${p.flows} | ${p.environments.length} |`,
        ''
      )
    } else if (part === 'map') {
      if (p.map) out.push('### Mapa do projeto', '', mermaid(p.map), '')
    } else if (part === 'c4') {
      if (p.c4) out.push(mermaid(p.c4), '')
    } else if (part === 'environments') {
      if (!p.environments.length) continue
      out.push('### Ambientes', '', '| Ambiente | Id | Variáveis | Segredos |', '| --- | --- | ---: | ---: |')
      for (const env of p.environments) {
        out.push(`| ${cell(env.name)} | ${code(env.id)} | ${env.variables} | ${env.secrets} |`)
      }
      out.push('')
    } else if (part === 'variables') {
      if (!doc.variables.length) continue
      out.push(
        '### Variáveis usadas',
        '',
        '| Variável | Tipo | Valor por ambiente | Ausente em |',
        '| --- | --- | --- | --- |'
      )
      for (const v of doc.variables) {
        const values = v.secret
          ? 'valor guardado no vault, nunca exportado'
          : Object.entries(v.values)
              .map(([env, value]) => `${code(env)}: ${code(value)}`)
              .join('<br>') || '—'
        out.push(
          `| ${code(`{{${v.name}}}`)}${v.description ? `<br>${cell(v.description)}` : ''} | ${v.secret ? '🔒 Segredo' : 'Valor'} | ${values} | ${v.missingIn.map(code).join(', ') || '—'} |`
        )
      }
      out.push('')
    } else if (p.flowList.length) {
      out.push('### Fluxos', '', '| Fluxo | Arquivo | Nós | Conectores |', '| --- | --- | ---: | --- |')
      for (const f of p.flowList) {
        out.push(
          `| ${cell(f.name)}${f.description ? `<br>${cell(f.description)}` : ''} | ${code(f.file)} | ${f.nodes} | ${f.connectors.map((c) => code(c)).join(', ') || '—'} |`
        )
      }
      out.push('')
    }
  }
}

/**
 * Trecho do documento gerado, para o documento do projeto ({{> ...}} no Markdown): as partes da
 * seção Projeto, um conector, um endpoint, uma request ou a referência inteira. Os títulos saem
 * nos níveis do documento gerado (## conector, ### endpoint); quem inclui ajusta. null: o item
 * não existe no documento.
 */
export type DocFragment =
  | { kind: ProjectPart | 'reference' | 'issues' }
  | { kind: 'connector'; connectorId: string }
  | { kind: 'endpoint'; connectorId: string; endpointId: string }
  | { kind: 'request'; connectorId: string; endpointId: string; scenarioId: string }

export function renderDocFragment(doc: ApiDocument, fragment: DocFragment): string | null {
  const out: string[] = []
  const names = new Map(doc.connectors.flatMap((c) => c.chain.map((x) => [x.id, x.name] as const)))
  const name = (id: string) => names.get(id) ?? id
  switch (fragment.kind) {
    case 'summary':
    case 'map':
    case 'c4':
    case 'environments':
    case 'variables':
    case 'flows':
      renderProject(doc, out, [fragment.kind])
      break
    case 'reference':
      for (const c of doc.connectors) renderConnector(c, out, name)
      break
    case 'issues':
      for (const i of doc.issues) out.push(`- ${code(i.file)}: ${escapeInline(i.message)}`)
      break
    default: {
      const c = doc.connectors.find((x) => x.id === fragment.connectorId)
      if (!c) return null
      if (fragment.kind === 'connector') {
        renderConnector(c, out, name)
        break
      }
      const e = c.endpoints.find((x) => x.id === fragment.endpointId)
      if (!e) return null
      if (fragment.kind === 'endpoint') {
        renderEndpoint(e, c, out, name)
        break
      }
      const sc = e.scenarios.find((x) => x.id === fragment.scenarioId)
      if (!sc) return null
      renderScenario(sc, out)
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Âncora de um título no formato do GitHub, sem o sufixo -1, -2... das repetidas. */
export function slugBase(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

export function connectorHeading(c: DocConnector): string {
  return `Conector ${c.name}`
}

export function endpointHeading(e: DocEndpoint): string {
  return `${e.method} ${e.path} · ${e.name}`
}

function renderConnector(c: DocConnector, out: string[], name: (id: string) => string) {
  out.push(`## ${escapeHeading(connectorHeading(c))}`, '')
  const meta: [string, string][] = [
    ['Id', code(c.id)],
    ['Versão', code(`v${c.version}`)],
    ['Arquivo', code(c.file)],
    ['Herda de', c.extends ? `${cell(name(c.extends))} (${code(c.extends)})` : 'nenhum (raiz)'],
    ['Cadeia de herança', c.chain.map((x) => cell(x.name)).join(' → ')]
  ]
  if (c.children.length) meta.push(['Filhos', c.children.map(cell).join(', ')])
  if (c.shared) meta.push(['Origem', `catálogo compartilhado ${code(c.shared)} (somente leitura)`])
  if (c.docsFile) meta.push(['Documentação escrita', code(c.docsFile)])
  out.push('| | |', '| --- | --- |', ...meta.map(([k, v]) => `| ${k} | ${v} |`), '')
  if (c.error) out.push(`> **Herança quebrada:** ${escapeInline(c.error)}`, '')
  if (c.description || c.overview) {
    out.push('### Documentação escrita', '')
    if (c.description) out.push(demote(c.description, 4), '')
    if (c.overview) out.push(demote(c.overview, 4), '')
  }

  out.push('### Hierarquia e herança', '')
  out.push(mermaid(c.diagrams.hierarchy), '')
  const r = c.effective
  if (r) {
    const origin = (from: string) => (from === c.id ? 'local' : `herdado de ${cell(name(from))}`)
    out.push('| Campo | Valor efetivo | Origem |', '| --- | --- | --- |')
    out.push(`| URL base | ${r.baseUrl ? code(r.baseUrl.value) : '—'} | ${r.baseUrl ? origin(r.baseUrl.from) : 'nenhum conector da cadeia define'} |`)
    out.push(`| basePath | ${r.basePath ? code(r.basePath) : '—'} | acumulado na cadeia |`)
    for (const h of r.headers) out.push(`| Header ${code(h.name)} | ${code(h.value)} | ${headerOrigin(h, c.id, name)} |`)
    out.push(
      `| Auth | ${r.auth ? cell(r.auth.summary) : r.authDisabledBy ? 'desligada' : 'nenhuma'} | ${r.auth ? origin(r.auth.from) : r.authDisabledBy ? origin(r.authDisabledBy) : '—'} |`
    )
    out.push(`| mTLS | ${r.tlsFrom ? 'certificado de cliente' : 'nenhum'} | ${r.tlsFrom ? origin(r.tlsFrom) : '—'} |`)
    out.push('', 'O filho sobrescreve headers pelo nome e troca auth e mTLS inteiros; o basePath acumula.', '')
  }

  if (r?.auth) {
    out.push('### Autenticação', '')
    out.push(`${cell(r.auth.summary)}, ${r.auth.from === c.id ? 'definida neste conector' : `herdada de ${cell(name(r.auth.from))}`}.`, '')
    if (r.auth.details.length) {
      out.push('| Campo | Valor |', '| --- | --- |', ...r.auth.details.map((d) => `| ${code(d.name)} | ${code(d.value)} |`), '')
    }
    if (c.diagrams.auth) out.push(mermaid(c.diagrams.auth), '')
  }

  out.push('### Endpoints', '')
  if (c.endpoints.length === 0) out.push('Este conector não declara endpoints.', '')
  else {
    out.push('| Método | Caminho | Nome | Requests |', '| --- | --- | --- | ---: |')
    for (const e of c.endpoints) out.push(`| ${code(e.method)} | ${code(e.path)} | ${cell(e.name)} | ${e.scenarios.length} |`)
    out.push('')
  }
  if (c.omittedEndpoints > 0) out.push(`_Mais ${c.omittedEndpoints} endpoint(s) do conector fora deste documento._`, '')
  for (const e of c.endpoints) renderEndpoint(e, c, out, name)
}

function renderEndpoint(
  e: DocEndpoint,
  c: DocConnector,
  out: string[],
  name: (id: string) => string
) {
  out.push(`### ${escapeHeading(endpointHeading(e))}`, '')
  out.push(`${code(e.method)} ${code(e.url ?? e.path)}`, '')
  if (e.requiresAuth === true) out.push('**Exige autenticação.** Sem credencial, a API responde 401 ou 403.', '')
  if (e.requiresAuth === false) out.push('**Público.** Funciona sem credencial.', '')
  if (e.description) out.push(demote(e.description, 5), '')
  if (e.docs) out.push(demote(e.docs, 5), '')

  out.push('#### Sequência', '', mermaid(e.diagrams.sequence), '')

  if (e.pathParams.length) {
    out.push('#### Parâmetros de rota', '', ...e.pathParams.map((p) => `- ${code(`{${p}}`)}`), '')
  }
  out.push('#### Headers efetivos', '')
  if (e.headers.length === 0) out.push('Nenhum header além dos da auth.', '')
  else {
    out.push('| Header | Valor | Origem |', '| --- | --- | --- |')
    for (const h of e.headers) out.push(`| ${code(h.name)} | ${code(h.value)} | ${headerOrigin(h, c.id, name)} |`)
    out.push('')
  }
  if (c.effective?.auth && e.requiresAuth !== false) out.push(`A auth (${cell(c.effective.auth.summary)}) entra em cada chamada, depois dos headers.`, '')
  if (e.query.length) {
    out.push('#### Query', '', '| Parâmetro | Valor |', '| --- | --- |')
    for (const q of e.query) out.push(`| ${code(q.name)} | ${code(q.value)} |`)
    out.push('')
  }
  if (e.fields.length || e.bodySchema || e.body !== undefined) {
    out.push('#### Corpo', '')
    if (e.sharedSchema) out.push(`Schema compartilhado ${code(e.sharedSchema.name)} (${code(e.sharedSchema.file)}), o mesmo em todos os endpoints que o citam.`, '')
    if (e.fields.length) {
      out.push('| Campo | Tipo | Obrigatório | Descrição |', '| --- | --- | --- | --- |')
      for (const f of e.fields) {
        out.push(`| ${code(f.path)} | ${code(f.values ? f.values.join(' | ') : f.type)} | ${f.required ? 'sim' : ''} | ${cell(f.description ?? '')} |`)
      }
      out.push('')
    }
    if (e.bodySchema) out.push('<details><summary>JSON Schema do corpo</summary>', '', fence(e.bodySchema, 'json'), '', '</details>', '')
    if (e.body !== undefined) out.push('Exemplo (corpo padrão):', '', fence(e.body, guessLanguage(e.body)), '')
  }
  if (e.checks.length) {
    out.push('#### Validação dos corpos com o schema', '')
    for (const k of e.checks) {
      out.push(`- ${k.issues.length ? '✗' : '✓'} ${escapeInline(k.label)}${k.issues.length ? ':' : ''}`)
      for (const i of k.issues) out.push(`  - ${code(i.path || '/')} ${escapeInline(i.message)}`)
    }
    out.push('')
  }
  if (e.scenarios.length) {
    out.push('#### Requests (cenários de teste)', '')
    for (const s of e.scenarios) renderScenario(s, out)
  }
  if (e.flows.length) {
    out.push('#### Fluxos que usam este endpoint', '')
    for (const f of e.flows) {
      out.push(`**${escapeInline(f.name)}** (${code(f.file)}), nós ${f.nodes.map(code).join(', ')}.`, '')
      if (f.description) out.push(escapeInline(f.description), '')
      out.push(mermaid(f.diagram), '')
    }
  }
}

function renderScenario(s: DocScenario, out: string[]) {
  out.push(`##### ${escapeHeading(s.name)}`, '')
  out.push(`Id ${code(s.id)}${s.expectedStatus !== undefined ? ` · espera HTTP ${s.expectedStatus}` : ''}`, '')
  if (s.description) out.push(demote(s.description, 6), '')
  const o = s.overrides
  const rows: string[] = []
  if (o.headers === null) rows.push('| Headers | todos os herdados removidos |')
  for (const h of o.headers ?? []) rows.push(`| Header ${code(h.name)} | ${h.value === null ? 'removido' : code(h.value)} |`)
  for (const q of o.query ?? []) rows.push(`| Query ${code(q.name)} | ${q.value === null ? 'removido' : code(q.value)} |`)
  for (const p of o.pathParams ?? []) rows.push(`| Rota ${code(`{${p.name}}`)} | ${code(p.value)} |`)
  if (rows.length) out.push('| Override | Valor |', '| --- | --- |', ...rows, '')
  if (o.body !== undefined) out.push('Corpo:', '', fence(o.body, guessLanguage(o.body)), '')
  if (s.check?.issues.length) {
    out.push(`Corpo fora do schema (${s.check.issues.length}):`, ...s.check.issues.map((i) => `- ${code(i.path || '/')} ${escapeInline(i.message)}`), '')
  }
  out.push('| Asserção | Operador | Esperado |', '| --- | --- | --- |')
  for (const a of s.assertions) out.push(`| ${code(a.target)} | ${code(a.operator)} | ${a.expected === undefined ? '—' : code(a.expected)} |`)
  out.push('')
}

function headerOrigin(h: DocHeader, self: string, name: (id: string) => string): string {
  const from = h.from === ENDPOINT_ORIGIN ? 'endpoint' : h.from === self ? 'local' : `herdado de ${cell(name(h.from))}`
  return h.overrides.length
    ? `${from}, substitui ${h.overrides.map((o) => (o === ENDPOINT_ORIGIN ? 'endpoint' : cell(name(o)))).join(', ')}`
    : from
}

function mermaid(source: string): string {
  return fence(source, 'mermaid')
}

/** Bloco de código com uma cerca maior que qualquer sequência de crases do conteúdo. */
function fence(text: string, lang: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const f = '`'.repeat(longest + 1)
  return `${f}${lang}\n${text.replace(/\n+$/, '')}\n${f}`
}

/** Código inline seguro dentro de uma célula de tabela. */
function code(text: string): string {
  const clean = text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
  const longest = Math.max(0, ...[...clean.matchAll(/`+/g)].map((m) => m[0].length))
  const f = '`'.repeat(longest + 1)
  const pad = clean.startsWith('`') || clean.endsWith('`') ? ' ' : ''
  return `${f}${pad}${clean}${pad}${f}`
}

function cell(text: string): string {
  return escapeInline(text).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

/** Texto do workspace como texto, não como HTML nem marcação. */
function escapeInline(text: string): string {
  return text.replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'))
}

function escapeHeading(text: string): string {
  return escapeInline(text).replace(/[\r\n]+/g, ' ').replace(/#+\s*$/, '')
}

/** Markdown escrito pelo usuário dentro de uma seção: títulos ficam abaixo do nível dela. */
function demote(markdown: string, minLevel: number): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  let fenceMark: string | null = null
  const headings = lines.filter((l) => /^#{1,6}\s/.test(l)).map((l) => /^(#+)/.exec(l)![1]!.length)
  const top = headings.length ? Math.min(...headings) : minLevel
  const shift = Math.max(0, minLevel - top)
  return lines
    .map((line) => {
      const f = /^\s*(`{3,}|~{3,})/.exec(line)
      if (fenceMark) {
        if (f && f[1]!.startsWith(fenceMark)) fenceMark = null
        return line
      }
      if (f) {
        fenceMark = f[1]!
        return line
      }
      const h = /^(#{1,6})(\s.*)$/.exec(line)
      // Títulos {#id} do arquivo de documentação perdem o marcador (o documento tem as próprias âncoras).
      return h ? `${'#'.repeat(Math.min(6, h[1]!.length + shift))}${h[2]!.replace(/\s*\{#[A-Za-z0-9_][A-Za-z0-9_.-]*\}\s*$/, '')}` : line
    })
    .join('\n')
    .trim()
}

function guessLanguage(text: string): string {
  const t = text.trim()
  return t.startsWith('{') || t.startsWith('[') ? 'json' : t.startsWith('<') ? 'xml' : 'text'
}

function formatDate(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC')
}
