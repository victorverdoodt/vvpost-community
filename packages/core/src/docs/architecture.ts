// Sem node:*: o lint, a montagem e o editor de diagramas leem os diagramas de arquitetura do mesmo jeito.
import type { Connector, Flow } from '@vvpost/schemas'

/**
 * Drift da arquitetura (docs/documentation.md#diagramas-c4-que-não-envelhecem): os diagramas de
 * arquitetura escritos à mão em Mermaid (C4 e, com anotação, fluxogramas e architecture-beta)
 * comparados com o que o workspace declara (conectores, endpoints e fluxos). Cada elemento é ligado
 * ao catálogo por uma anotação que o Mermaid ignora (`%% vvpost:bind <alias> connector:<id>`) ou,
 * sem ela, pelo nome; o que diverge vira um item de drift que o lint reporta (app, `vvpost lint` e
 * MCP) e que, quando dá, traz a correção do texto (`fix`).
 */

export type C4ElementKind = 'person' | 'system' | 'container' | 'component' | 'boundary' | 'node'

export interface C4Element {
  alias: string
  /** A macro como escrita: System_Ext, ContainerDb... (subgraph, node, group ou service fora do C4). */
  macro: string
  kind: C4ElementKind
  external: boolean
  label: string
  technology?: string
  description?: string
  /** Alias da fronteira (Boundary, Deployment_Node, subgraph, group) em que o elemento está. */
  parent?: string
  /** Linha no arquivo (a partir de 1). */
  line: number
  /** A linha só declara o elemento: dá para tirá-la sem levar outra coisa junto. */
  alone: boolean
}

export interface C4Relation {
  macro: string
  from: string
  to: string
  label?: string
  technology?: string
  line: number
  /** A linha só tem esta relação. */
  alone: boolean
}

export type ArchitectureRef = { kind: 'connector' | 'flow'; id: string }

export interface DiagramBinding extends ArchitectureRef {
  alias: string
  line: number
}

export type DiagramSyntax = 'c4' | 'flowchart' | 'architecture'

export interface ArchitectureDiagram {
  /** Arquivo do workspace: um .md (com a linha do ```mermaid) ou um .mmd. */
  file: string
  /** Linha do ```mermaid que abre o bloco; ausente num .mmd. */
  line?: number
  /** Última linha do código do diagrama no arquivo: onde a correção acrescenta o que falta. */
  end: number
  /** C4Context, C4Container, C4Component, C4Dynamic, C4Deployment, flowchart ou architecture-beta. */
  type: string
  syntax: DiagramSyntax
  title?: string
  elements: C4Element[]
  relations: C4Relation[]
  bindings: DiagramBinding[]
  /** `%% vvpost:cover connectors flows`: o diagrama precisa mostrar todos. */
  covers: ('connectors' | 'flows')[]
  /** `%% vvpost:ignore connector:<id>`: fora do diagrama de propósito. */
  ignores: (ArchitectureRef & { line: number })[]
  /** Anotações que não deu para ler. */
  invalid: { line: number; text: string }[]
}

export type DriftCode =
  | 'c4-binding-unknown'
  | 'c4-connector-missing'
  | 'c4-flow-missing'
  | 'c4-relation-missing'
  | 'c4-relation-stale'
  | 'c4-relation-unknown-element'
  | 'c4-element-ambiguous'
  | 'doc-unknown-reference'
  | 'doc-stale-since-change'
  | 'doc-code-map'

/** Correção de um item de drift, em linhas do arquivo de antes (a partir de 1). */
export interface DriftFix {
  /** Linhas a tirar. */
  remove?: number[]
  /** Linhas a acrescentar depois da linha `after`. */
  insert?: { after: number; lines: string[] }
}

export interface DriftItem {
  code: DriftCode
  message: string
  /** Como corrigir, com o trecho de Mermaid pronto quando dá. */
  hint?: string
  file: string
  line?: number
  /** Onde, em palavras: o elemento, a relação ou o item do catálogo. */
  label?: string
  connectorId?: string
  flowId?: string
  /** A correção automática, quando o VVPost sabe fazer (fix_diagrams, vvpost lint --fix, app). */
  fix?: DriftFix
}

export const ANNOTATION = '%% vvpost:'
const C4_TYPES = /^(C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)\b/
const FLOW_TYPES = /^(flowchart|graph)\b/
const ARCH_TYPES = /^architecture-beta\b/
const ELEMENT = /^(Person|System|Container|Component)(Db|Queue)?(_Ext)?$/
const BOUNDARY = /^(Boundary|Enterprise_Boundary|System_Boundary|Container_Boundary)$/
const NODE = /^(Deployment_Node|Node|Node_L|Node_R)$/
const RELATION = /^(Bi)?Rel(_(U|Up|D|Down|L|Left|R|Right|Back|Neighbor))?$/
const CALL = /^\s*([A-Za-z_][\w]*)\s*\((.*)\)\s*(\{)?\s*$/
const MERMAID_OPEN = /^\s{0,3}(`{3,}|~{3,})\s*mermaid\s*$/i
const FENCE = /^\s{0,3}(`{3,}|~{3,})/

/** Os argumentos de uma macro: separados por vírgula fora das aspas, sem aspas e sem os $nome=valor. */
function splitArgs(text: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    else if (ch === ',' && !quoted) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)
  return out
    .map((a) => a.trim())
    .filter((a) => !a.startsWith('$'))
    .map((a) => (a.startsWith('"') && a.endsWith('"') && a.length >= 2 ? a.slice(1, -1) : a).trim())
}

const optional = (key: string, value: string | undefined) => (value ? { [key]: value } : {})

function parseRef(text: string): ArchitectureRef | null {
  const m = /^(connector|flow):(\S+)$/.exec(text)
  return m ? { kind: m[1] as ArchitectureRef['kind'], id: m[2]! } : null
}

/** Lê uma linha `%% vvpost:` no diagrama. */
function readAnnotation(diagram: ArchitectureDiagram, text: string, line: number): void {
  const [verb, ...rest] = text.slice(ANNOTATION.length).trim().split(/\s+/)
  if (verb === 'bind' && rest.length >= 2) {
    const refs = rest.slice(1).map(parseRef)
    if (refs.every(Boolean)) {
      for (const ref of refs) diagram.bindings.push({ alias: rest[0]!, ...ref!, line })
      return
    }
  } else if (verb === 'cover' && rest.length && rest.every((r) => r === 'connectors' || r === 'flows')) {
    for (const r of rest as ('connectors' | 'flows')[]) if (!diagram.covers.includes(r)) diagram.covers.push(r)
    return
  } else if (verb === 'ignore' && rest.length && rest.every((r) => parseRef(r))) {
    for (const r of rest) diagram.ignores.push({ ...parseRef(r)!, line })
    return
  }
  diagram.invalid.push({ line, text })
}

/**
 * Um diagrama de arquitetura em Mermaid: elementos, fronteiras, relações e as anotações
 * `%% vvpost:`. C4 sempre conta; fluxograma e architecture-beta só com alguma anotação (o time diz
 * que aquele diagrama é de arquitetura). null: não é diagrama de arquitetura.
 */
export function parseArchitectureDiagram(code: string, origin: { file: string; line?: number }): ArchitectureDiagram | null {
  const lines = code.replace(/\r\n?/g, '\n').split('\n')
  const head = lines.find((l) => l.trim() && !l.trim().startsWith('%%'))?.trim() ?? ''
  const c4 = C4_TYPES.exec(head)?.[1]
  const syntax: DiagramSyntax | undefined = c4 ? 'c4' : FLOW_TYPES.test(head) ? 'flowchart' : ARCH_TYPES.test(head) ? 'architecture' : undefined
  if (!syntax) return null
  if (syntax !== 'c4' && !lines.some((l) => l.trim().startsWith(ANNOTATION))) return null
  const firstLine = origin.line !== undefined ? origin.line + 1 : 1
  let last = lines.length - 1
  while (last > 0 && !lines[last]!.trim()) last--
  const diagram: ArchitectureDiagram = {
    file: origin.file,
    ...(origin.line !== undefined && { line: origin.line }),
    end: firstLine + Math.max(last, 0),
    type: c4 ?? (syntax === 'flowchart' ? 'flowchart' : 'architecture-beta'),
    syntax,
    elements: [],
    relations: [],
    bindings: [],
    covers: [],
    ignores: [],
    invalid: []
  }
  const read = syntax === 'c4' ? readC4Line : syntax === 'flowchart' ? flowchartReader() : readArchitectureLine
  const stack: string[] = []
  let headerSeen = false
  lines.forEach((raw, i) => {
    const line = firstLine + i
    const text = raw.trim()
    if (!text) return
    if (text.startsWith(ANNOTATION)) return readAnnotation(diagram, text, line)
    if (text.startsWith('%%')) return
    if (!headerSeen) {
      headerSeen = true
      return
    }
    if (/^title\s/.test(text)) {
      diagram.title = text.slice(5).trim()
      return
    }
    read(diagram, text, line, stack)
  })
  return diagram
}

/** Só C4 (o leitor antigo, para quem já chamava). */
export function parseC4Diagram(code: string, origin: { file: string; line?: number }): ArchitectureDiagram | null {
  const d = parseArchitectureDiagram(code, origin)
  return d?.syntax === 'c4' ? d : null
}

type LineReader = (diagram: ArchitectureDiagram, text: string, line: number, stack: string[]) => void

const readC4Line: LineReader = (diagram, text, line, stack) => {
  if (text.startsWith('}')) {
    stack.pop()
    return
  }
  const call = CALL.exec(text)
  if (!call) return
  const macro = call[1]!
  const args = splitArgs(call[2]!)
  const parent = stack.at(-1)
  const element = (kind: C4ElementKind, external: boolean, technology?: string, description?: string) => {
    const alias = args[0]
    if (!alias) return
    diagram.elements.push({
      alias,
      macro,
      kind,
      external,
      label: args[1] || alias,
      ...optional('technology', technology),
      ...optional('description', description),
      ...(parent !== undefined && { parent }),
      line,
      // Uma fronteira abre um bloco: tirar a linha deixaria o } sem par.
      alone: !call[3]
    })
  }
  const el = ELEMENT.exec(macro)
  if (el) {
    const kind = el[1]!.toLowerCase() as C4ElementKind
    const withTech = kind === 'container' || kind === 'component'
    element(kind, !!el[3], withTech ? args[2] : undefined, withTech ? args[3] : args[2])
  } else if (BOUNDARY.test(macro)) {
    element('boundary', false, args[2])
  } else if (NODE.test(macro)) {
    element('node', false, args[2], args[3])
  } else if (RELATION.test(macro) || macro === 'RelIndex') {
    const [from, to, label, technology] = macro === 'RelIndex' ? args.slice(1) : args
    if (from && to) diagram.relations.push({ macro, from, to, ...optional('label', label), ...optional('technology', technology), line, alone: true })
  }
  if (call[3]) stack.push(args[0] ?? '')
}

// Fluxograma: as mesmas setas e formas que o mermaid-split entende.
const FLOW_ARROW = /\s*(?:<?-->|<?---|-\.->|-\.-|<?==>|===|--[ox]|--\s[^>]*?-->|-\.\s[^>]*?\.->)\s*(?:\|[^|]*\|)?\s*/
const FLOW_SHAPED = /\b([A-Za-z_][\w-]*)\s*(\(\[|\[\[|\[\(|\(\(|\{\{|\[|\(|\{|>)\s*(?:"([^"]*)"|([^"\]\)\}|]+))/g
const FLOW_AT = /\b([A-Za-z_][\w-]*)@\{([^}]*)\}/g
const FLOW_ID = /^([A-Za-z_][\w-]*)/
const FLOW_SKIP = /^(classDef|class|style|linkStyle|click|direction)\b/
const FLOW_SUBGRAPH = /^subgraph\s+(?:([A-Za-z_][\w-]*)\s*)?(?:\[\s*"?([^\]"]*)"?\s*\]|"([^"]*)")?\s*$/

function flowchartReader(): LineReader {
  return (diagram, text, line, stack) => {
    if (text === 'end') {
      stack.pop()
      return
    }
    if (FLOW_SKIP.test(text)) return
    const parent = stack.at(-1)
    const sub = FLOW_SUBGRAPH.exec(text)
    if (sub) {
      const label = (sub[2] ?? sub[3] ?? sub[1] ?? '').trim()
      const alias = sub[1] ?? normalizeName(label).replace(/\s+/g, '_')
      diagram.elements.push({ alias, macro: 'subgraph', kind: 'boundary', external: false, label: label || alias, ...(parent !== undefined && { parent }), line, alone: false })
      stack.push(alias)
      return
    }
    const known = new Set(diagram.elements.map((e) => e.alias))
    const declare = (alias: string, label: string | undefined, alone: boolean) => {
      if (known.has(alias)) {
        const e = diagram.elements.find((x) => x.alias === alias)!
        if (label && e.label === alias) e.label = label
        return
      }
      known.add(alias)
      diagram.elements.push({ alias, macro: 'node', kind: 'container', external: false, label: label || alias, ...(parent !== undefined && { parent }), line, alone })
    }
    const unquoted = text.replace(/"[^"]*"/g, '""').replace(/@\{[^}]*\}/g, '')
    const segments = unquoted.split(FLOW_ARROW).map((s) => s.trim()).filter(Boolean)
    const groups = segments.map((s) =>
      s
        .split('&')
        .map((part) => FLOW_ID.exec(part.trim())?.[1])
        .filter((id): id is string => !!id)
    )
    const shaped = [...text.matchAll(FLOW_SHAPED)]
    const singleNode = segments.length === 1 && groups[0]?.length === 1
    for (const m of text.matchAll(FLOW_AT)) {
      const label = /label\s*:\s*"([^"]*)"/.exec(m[2]!)?.[1]
      declare(m[1]!, label, singleNode)
    }
    for (const m of shaped) {
      if (!groups.flat().includes(m[1]!)) continue
      declare(m[1]!, (m[3] ?? m[4] ?? '').trim() || undefined, singleNode)
    }
    if (segments.length < 2) {
      if (singleNode) declare(groups[0]![0]!, undefined, true)
      return
    }
    for (const g of groups) for (const id of g) declare(id, undefined, false)
    const bare = groups.every((g) => g.length === 1) && segments.every((s, i) => s === groups[i]![0])
    for (let i = 0; i + 1 < groups.length; i++) {
      for (const from of groups[i]!) {
        for (const to of groups[i + 1]!) diagram.relations.push({ macro: 'edge', from, to, line, alone: bare && segments.length === 2 })
      }
    }
  }
}

const ARCH_DECL = /^(group|service)\s+([\w-]+)\s*(?:\(([^)]*)\))?\s*(?:\[([^\]]*)\])?\s*(?:in\s+([\w-]+))?\s*$/
const ARCH_EDGE = /^([\w-]+)(?:\{group\})?\s*:\s*[LRTB]\s*<?--?>?\s*[LRTB]\s*:\s*([\w-]+)(?:\{group\})?\s*$/

const readArchitectureLine: LineReader = (diagram, text, line) => {
  const decl = ARCH_DECL.exec(text)
  if (decl) {
    diagram.elements.push({
      alias: decl[2]!,
      macro: decl[1]!,
      kind: decl[1] === 'group' ? 'boundary' : 'container',
      external: false,
      label: decl[4]?.trim() || decl[2]!,
      ...optional('technology', decl[3]?.trim()),
      ...(decl[5] && { parent: decl[5] }),
      line,
      alone: decl[1] === 'service'
    })
    return
  }
  const edge = ARCH_EDGE.exec(text)
  if (edge) diagram.relations.push({ macro: 'edge', from: edge[1]!, to: edge[2]!, line, alone: true })
}

/** Os diagramas de arquitetura de um Markdown (blocos ```mermaid) ou de um .mmd. */
export function architectureDiagrams(file: string, text: string): ArchitectureDiagram[] {
  if (/\.mmd$/i.test(file)) {
    const d = parseArchitectureDiagram(text, { file })
    return d ? [d] : []
  }
  const out: ArchitectureDiagram[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const open = MERMAID_OPEN.exec(lines[i]!)
    if (!open) {
      const other = FENCE.exec(lines[i]!)
      if (other) i = closeOf(lines, i, other[1]!)
      continue
    }
    const end = closeOf(lines, i, open[1]!)
    const d = parseArchitectureDiagram(lines.slice(i + 1, end).join('\n'), { file, line: i + 1 })
    if (d) out.push(d)
    i = end
  }
  return out
}

function closeOf(lines: string[], open: number, fence: string): number {
  for (let j = open + 1; j < lines.length; j++) {
    const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[j]!)
    if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) return j
  }
  return lines.length
}

// --- Ligação com o catálogo ---

/** Texto comparável: sem acento, minúsculas, só letras e números separados por espaço. */
export function normalizeName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** O começo comum dos ids (`connector.` em connector.pagamentos e connector.clientes), para tirar. */
function commonPrefix(ids: readonly string[]): string[] {
  if (ids.length < 2) return []
  const split = ids.map((id) => id.split(/[.\-_/:]+/))
  const out: string[] = []
  for (let i = 0; ; i++) {
    const token = split[0]![i]
    if (token === undefined || split.some((s) => s[i] !== token || s.length <= i + 1)) return out
    out.push(token)
  }
}

interface Candidate {
  ref: ArchitectureRef
  strong: Set<string>
  weak: Set<string>
}

function candidates(kind: ArchitectureRef['kind'], items: readonly { id: string; name: string }[]): Candidate[] {
  const prefix = commonPrefix(items.map((i) => i.id))
  return items.map((item) => {
    const tokens = item.id.split(/[.\-_/:]+/)
    const stripped = tokens.slice(prefix.length).join(' ')
    const strong = new Set([normalizeName(item.name), normalizeName(item.id), normalizeName(stripped)].filter((k) => k.length >= 2))
    const unversioned = normalizeName(stripped.replace(/(^|\s)v\d+(\.\d+)*$/i, ''))
    const weak = new Set([unversioned, normalizeName(item.name.replace(/\s+v\d+(\.\d+)*$/i, ''))].filter((k) => k.length >= 2 && !strong.has(k)))
    return { ref: { kind, id: item.id }, strong, weak }
  })
}

/** O item do catálogo com o nome do elemento: primeiro pelo nome e id inteiros, depois sem a versão. */
function matchByName(element: C4Element, pool: readonly Candidate[]): { ref?: ArchitectureRef; ambiguous?: ArchitectureRef[] } {
  if (element.kind === 'person') return {}
  const keys = [normalizeName(element.alias), normalizeName(element.label)].filter(Boolean)
  for (const level of ['strong', 'weak'] as const) {
    const hits = pool.filter((c) => keys.some((k) => c[level].has(k)))
    if (hits.length === 1) return { ref: hits[0]!.ref }
    if (hits.length > 1) return { ambiguous: hits.map((h) => h.ref) }
  }
  return {}
}

export interface ArchitectureCatalog {
  /** Todos os conectores do workspace (os compartilhados também), para saber o que existe. */
  connectors: readonly Connector[]
  /** Os conectores do projeto: os que a arquitetura precisa mostrar (os que têm endpoint). */
  ownConnectors: readonly Connector[]
  /** Os fluxos comuns do projeto. */
  flows: readonly { file: string; flow: Flow }[]
}

/** Elemento e o item do catálogo que ele representa, e como foi ligado. */
export interface ElementLink {
  diagram: ArchitectureDiagram
  element: C4Element
  ref: ArchitectureRef
  by: 'bind' | 'name'
}

/** Os conectores e fluxos que cada elemento de cada diagrama representa. */
export function linkDiagrams(
  diagrams: readonly ArchitectureDiagram[],
  catalog: ArchitectureCatalog
): { links: ElementLink[]; ambiguous: { diagram: ArchitectureDiagram; element: C4Element; refs: ArchitectureRef[] }[] } {
  const pool = [...candidates('connector', catalog.connectors), ...candidates('flow', catalog.flows.map((f) => f.flow))]
  const links: ElementLink[] = []
  const ambiguous: { diagram: ArchitectureDiagram; element: C4Element; refs: ArchitectureRef[] }[] = []
  for (const diagram of diagrams) {
    const bound = new Set(diagram.bindings.map((b) => b.alias))
    for (const element of diagram.elements) {
      if (bound.has(element.alias)) {
        for (const b of diagram.bindings) if (b.alias === element.alias) links.push({ diagram, element, ref: { kind: b.kind, id: b.id }, by: 'bind' })
        continue
      }
      const found = matchByName(element, pool)
      if (found.ref) links.push({ diagram, element, ref: found.ref, by: 'name' })
      else if (found.ambiguous) ambiguous.push({ diagram, element, refs: found.ambiguous })
    }
  }
  return { links, ambiguous }
}

/** Diagrama em palavras, para as mensagens: "C4Container em docs/projeto.md:20". */
function where(d: ArchitectureDiagram): string {
  return `${d.title ? `"${d.title}"` : d.type} (${d.file}${d.line !== undefined ? `:${d.line}` : ''})`
}

/** Um alias livre no diagrama, a partir do id do item do catálogo. */
function freeAlias(d: ArchitectureDiagram, id: string, taken: Set<string>): string {
  const base = (normalizeName(id).replace(/\s+/g, '_') || 'item').replace(/^(\d)/, '_$1')
  for (const e of d.elements) taken.add(e.alias)
  let alias = base
  for (let n = 2; taken.has(alias); n++) alias = `${base}_${n}`
  taken.add(alias)
  return alias
}

const quote = (text: string) => text.replace(/"/g, "'").replace(/[\r\n]+/g, ' ')
const plain = (text: string) => text.replace(/[[\]()"]/g, ' ').replace(/\s+/g, ' ').trim()
const short = (text: string | undefined, max = 80) => (text && text.length > max ? `${text.slice(0, max - 3)}...` : text)

/** O Mermaid de um elemento novo, na sintaxe do diagrama. */
function elementLine(d: ArchitectureDiagram, alias: string, name: string, kind: ArchitectureRef['kind'], description?: string): string {
  if (d.syntax === 'flowchart') return kind === 'flow' ? `${alias}(["${quote(name)}"])` : `${alias}["${quote(name)}"]`
  if (d.syntax === 'architecture') return `service ${alias}(server)[${plain(name)}]`
  if (kind === 'flow') return `Component(${alias}, "${quote(name)}", "Fluxo")`
  return `System_Ext(${alias}, "${quote(name)}"${description ? `, "${quote(short(description, 60)!)}"` : ''})`
}

function relationLine(d: ArchitectureDiagram, from: string, to: string): string {
  if (d.syntax === 'flowchart') return `${from} --> ${to}`
  if (d.syntax === 'architecture') return `${from}:R --> L:${to}`
  return `Rel(${from}, ${to}, "Chama")`
}

/** O recuo das linhas do diagrama, para o que a correção acrescenta. */
const INDENT = '  '

/**
 * Compara os diagramas de arquitetura com o catálogo. Achados:
 *
 * - `c4-binding-unknown`: anotação que liga a um conector ou fluxo que não existe mais, a um
 *   elemento que não está no diagrama, ou que não dá para ler;
 * - `c4-connector-missing` / `c4-flow-missing`: conector com endpoint (ou fluxo, com
 *   `cover flows`) que nenhum diagrama mostra (ou o diagrama com `cover`);
 * - `c4-relation-missing` / `c4-relation-stale`: elemento de um fluxo sem relação com um conector
 *   que o fluxo chama, ou com relação para um que ele não chama mais;
 * - `c4-relation-unknown-element`: relação com um alias que o diagrama não declara;
 * - `c4-element-ambiguous`: elemento cujo nome serve para mais de um item do catálogo.
 */
export function architectureDrift(diagrams: readonly ArchitectureDiagram[], catalog: ArchitectureCatalog): DriftItem[] {
  const items: DriftItem[] = []
  if (!diagrams.length) return items
  const connectors = new Map(catalog.connectors.map((c) => [c.id, c]))
  const flows = new Map(catalog.flows.map((f) => [f.flow.id, f.flow]))
  const exists = (r: ArchitectureRef) => (r.kind === 'connector' ? connectors.has(r.id) : flows.has(r.id))
  const noun = (r: ArchitectureRef) => (r.kind === 'connector' ? 'conector' : 'fluxo')
  const aliasesTaken = new Map<ArchitectureDiagram, Set<string>>()
  const taken = (d: ArchitectureDiagram) => aliasesTaken.get(d) ?? aliasesTaken.set(d, new Set()).get(d)!

  for (const d of diagrams) {
    const aliases = new Set(d.elements.map((e) => e.alias))
    for (const inv of d.invalid) {
      items.push({
        code: 'c4-binding-unknown',
        message: `anotação que não dá para ler: ${short(inv.text)}`,
        hint: 'Use %% vvpost:bind <alias> connector:<id> (ou flow:<id>), %% vvpost:cover connectors flows ou %% vvpost:ignore connector:<id>.',
        file: d.file,
        line: inv.line,
        label: where(d)
      })
    }
    for (const b of d.bindings) {
      if (!aliases.has(b.alias)) {
        items.push({
          code: 'c4-binding-unknown',
          message: `a anotação liga "${b.alias}", que não é um elemento do diagrama`,
          hint: `Corrija o alias na anotação ou tire a linha se o elemento saiu do diagrama.`,
          file: d.file,
          line: b.line,
          label: where(d),
          fix: { remove: [b.line] }
        })
      } else if (!exists(b)) {
        // O elemento sai com as relações dele, a não ser que ainda represente outra coisa.
        const others = d.bindings.filter((x) => x.alias === b.alias && x !== b && exists(x))
        const element = d.elements.find((e) => e.alias === b.alias)!
        const remove = [b.line]
        if (!others.length) {
          if (element.alone) remove.push(element.line)
          for (const r of d.relations) if ((r.from === b.alias || r.to === b.alias) && r.alone) remove.push(r.line)
        }
        items.push({
          code: 'c4-binding-unknown',
          message: `o elemento "${b.alias}" representa o ${noun(b)} ${b.id}, que não existe mais no workspace`,
          hint: `O diagrama ficou velho: tire o elemento "${b.alias}" (e as relações dele) ou ligue-o ao ${noun(b)} que tomou o lugar.`,
          file: d.file,
          line: b.line,
          label: b.alias,
          ...(b.kind === 'connector' ? { connectorId: b.id } : { flowId: b.id }),
          fix: { remove }
        })
      }
    }
    for (const ig of d.ignores) {
      if (!exists(ig)) {
        items.push({
          code: 'c4-binding-unknown',
          message: `o diagrama ignora o ${noun(ig)} ${ig.id}, que não existe mais`,
          hint: 'Tire a linha %% vvpost:ignore.',
          file: d.file,
          line: ig.line,
          label: where(d),
          ...(d.ignores.filter((x) => x.line === ig.line).every((x) => !exists(x)) && { fix: { remove: [ig.line] } })
        })
      }
    }
    for (const r of d.relations) {
      for (const end of [r.from, r.to]) {
        if (!aliases.has(end)) {
          items.push({
            code: 'c4-relation-unknown-element',
            message: `a relação ${r.from} → ${r.to} usa "${end}", que o diagrama não declara`,
            hint: `Declare o elemento "${end}" ou corrija o alias da relação.`,
            file: d.file,
            line: r.line,
            label: where(d)
          })
        }
      }
    }
  }

  const { links, ambiguous } = linkDiagrams(diagrams, catalog)
  for (const a of ambiguous) {
    items.push({
      code: 'c4-element-ambiguous',
      message: `o elemento "${a.element.alias}" (${a.element.label}) tem o nome de mais de um item do catálogo: ${a.refs.map((r) => r.id).join(', ')}`,
      hint: `Diga qual com %% vvpost:bind ${a.element.alias} ${a.refs[0]!.kind}:${a.refs[0]!.id}`,
      file: a.diagram.file,
      line: a.element.line,
      label: a.element.alias
    })
  }

  // Família: um elemento ligado a um conector-base sem endpoints representa os descendentes dele.
  const childrenOf = new Map<string, string[]>()
  for (const c of catalog.connectors) if (c.extends) childrenOf.set(c.extends, [...(childrenOf.get(c.extends) ?? []), c.id])
  const family = (id: string): string[] => {
    const out = [id]
    for (let i = 0; i < out.length && out.length < 500; i++) for (const child of childrenOf.get(out[i]!) ?? []) if (!out.includes(child)) out.push(child)
    return out
  }
  /** Os conectores que o elemento representa no diagrama. */
  const represented = (link: ElementLink): string[] => {
    if (link.ref.kind !== 'connector') return []
    const c = connectors.get(link.ref.id)
    return link.by === 'bind' && c && !c.endpoints?.length ? family(link.ref.id) : [link.ref.id]
  }

  // --- Cobertura ---
  const ORDER = ['C4Container', 'C4Context', 'C4Component', 'C4Dynamic', 'C4Deployment', 'architecture-beta', 'flowchart']
  const anchor = [...diagrams].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type))[0]!
  const missingIn = (scope: readonly ArchitectureDiagram[], kind: 'connectors' | 'flows', at: ArchitectureDiagram, strict: boolean) => {
    const inScope = links.filter((l) => scope.includes(l.diagram))
    const ignored = new Set(scope.flatMap((d) => d.ignores).map((i) => `${i.kind}:${i.id}`))
    const shown = new Set<string>()
    for (const l of inScope) {
      if (l.ref.kind === 'flow') shown.add(`flow:${l.ref.id}`)
      for (const id of represented(l)) shown.add(`connector:${id}`)
    }
    const place = strict ? `no diagrama ${where(at)}` : 'em nenhum diagrama de arquitetura'
    const add = (ref: ArchitectureRef, name: string, description: string | undefined) => {
      const alias = freeAlias(at, ref.id, taken(at))
      const lines = [elementLine(at, alias, name, ref.kind, description), `%% vvpost:bind ${alias} ${ref.kind}:${ref.id}`]
      // Os fluxos do diagrama que chamam o conector novo ganham a relação junto.
      if (ref.kind === 'connector') {
        for (const l of links) {
          if (l.diagram !== at || l.ref.kind !== 'flow' || !flows.get(l.ref.id) || !flowConnectors(flows.get(l.ref.id)!).has(ref.id)) continue
          lines.push(relationLine(at, l.element.alias, alias))
        }
      }
      items.push({
        code: ref.kind === 'connector' ? 'c4-connector-missing' : 'c4-flow-missing',
        message: `o ${noun(ref)} ${ref.id} (${name}) não aparece ${place}`,
        hint: `Acrescente o elemento e a ligação ao diagrama, por exemplo:\n${lines.map((l) => `${INDENT}${l}`).join('\n')}\nSe ele fica fora do diagrama de propósito: %% vvpost:ignore ${ref.kind}:${ref.id}`,
        file: at.file,
        ...(at.line !== undefined && { line: at.line }),
        label: ref.id,
        ...(ref.kind === 'connector' ? { connectorId: ref.id } : { flowId: ref.id }),
        fix: { insert: { after: at.end, lines: lines.map((l) => `${INDENT}${l}`) } }
      })
    }
    if (kind === 'connectors') {
      for (const c of catalog.ownConnectors) {
        if (!c.endpoints?.length || shown.has(`connector:${c.id}`) || ignored.has(`connector:${c.id}`)) continue
        add({ kind: 'connector', id: c.id }, c.name, c.description)
      }
    } else {
      for (const { flow } of catalog.flows) {
        if (shown.has(`flow:${flow.id}`) || ignored.has(`flow:${flow.id}`)) continue
        add({ kind: 'flow', id: flow.id }, flow.name, undefined)
      }
    }
  }
  const covering = (kind: 'connectors' | 'flows') => diagrams.filter((d) => d.covers.includes(kind))
  if (covering('connectors').length) for (const d of covering('connectors')) missingIn([d], 'connectors', d, true)
  else missingIn(diagrams, 'connectors', anchor, false)
  for (const d of covering('flows')) missingIn([d], 'flows', d, true)

  // --- Relações dos fluxos ---
  for (const d of diagrams) {
    const own = links.filter((l) => l.diagram === d)
    const byAlias = new Map(d.elements.map((e) => [e.alias, e]))
    /** O alias e as fronteiras em volta dele. */
    const up = (alias: string): string[] => {
      const out = [alias]
      for (let p = byAlias.get(alias)?.parent; p !== undefined && !out.includes(p); p = byAlias.get(p)?.parent) out.push(p)
      return out
    }
    /** O alias e o que está dentro dele (uma fronteira). */
    const down = (alias: string): string[] => {
      const out = [alias]
      for (let i = 0; i < out.length; i++) for (const e of d.elements) if (e.parent === out[i] && !out.includes(e.alias)) out.push(e.alias)
      return out
    }
    const linked = (a: string, b: string) => {
      const as = new Set([...up(a), ...down(a)])
      const bs = new Set(up(b))
      return d.relations.some((r) => (as.has(r.from) && bs.has(r.to)) || (as.has(r.to) && bs.has(r.from)))
    }
    const connectorElements = new Map<string, string[]>()
    for (const l of own) for (const id of represented(l)) connectorElements.set(id, [...(connectorElements.get(id) ?? []), l.element.alias])
    for (const l of own) {
      if (l.ref.kind !== 'flow') continue
      const flow = flows.get(l.ref.id)
      if (!flow) continue
      const calls = flowConnectors(flow)
      for (const c of calls) {
        const targets = connectorElements.get(c)
        if (!targets?.length || targets.some((t) => linked(l.element.alias, t))) continue
        const rel = relationLine(d, l.element.alias, targets[0]!)
        items.push({
          code: 'c4-relation-missing',
          message: `o fluxo ${flow.id} chama o conector ${c}, mas o diagrama não liga "${l.element.alias}" a "${targets[0]}"`,
          hint: `Acrescente a relação: ${rel}`,
          file: d.file,
          line: l.element.line,
          label: l.element.alias,
          flowId: flow.id,
          connectorId: c,
          fix: { insert: { after: d.end, lines: [`${INDENT}${rel}`] } }
        })
      }
      // Relação direta do fluxo com um conector que ele não chama mais.
      for (const r of d.relations) {
        const other = r.from === l.element.alias ? r.to : r.to === l.element.alias ? r.from : undefined
        if (other === undefined) continue
        const target = own.find((x) => x.element.alias === other && x.ref.kind === 'connector')
        if (!target || !connectors.has(target.ref.id)) continue
        const covered = represented(target)
        if (covered.some((id) => calls.has(id))) continue
        items.push({
          code: 'c4-relation-stale',
          message: `a relação ${r.from} → ${r.to} diz que o fluxo ${flow.id} usa o conector ${target.ref.id}, que ele não chama mais`,
          hint: 'Tire a relação do diagrama ou confira se o fluxo perdeu um passo.',
          file: d.file,
          line: r.line,
          label: `${r.from} → ${r.to}`,
          flowId: flow.id,
          connectorId: target.ref.id,
          ...(r.alone && { fix: { remove: [r.line] } })
        })
      }
    }
  }
  return items
}

/**
 * Aplica as correções de um arquivo ao texto dele: tira as linhas e acrescenta as novas, todas
 * em linhas do texto de antes. Linha repetida (duas correções tirando a mesma) sai uma vez.
 */
export function applyDriftFixes(text: string, fixes: readonly DriftFix[]): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const remove = new Set(fixes.flatMap((f) => f.remove ?? []))
  const inserts = new Map<number, string[]>()
  for (const f of fixes) {
    if (!f.insert) continue
    const list = inserts.get(f.insert.after) ?? []
    for (const l of f.insert.lines) if (!list.includes(l)) list.push(l)
    inserts.set(f.insert.after, list)
  }
  const out: string[] = []
  lines.forEach((line, i) => {
    if (!remove.has(i + 1)) out.push(line)
    out.push(...(inserts.get(i + 1) ?? []))
  })
  return out.join(eol)
}

/** Conectores que o fluxo chama (nós de requisição e de plugin). */
export function flowConnectors(flow: Flow): Set<string> {
  const out = new Set<string>()
  for (const n of flow.nodes) {
    if (n.type === 'request' && n.request.connector) out.add(n.request.connector)
    if (n.type === 'plugin' && n.plugin.connector) out.add(n.plugin.connector)
  }
  return out
}

const INLINE_CODE = /`([^`\n]+)`/g
const ID_LIKE = /^[A-Za-z0-9_][\w.-]*$/
const FILE_LIKE = /\.(json|md|mmd|ya?ml|ts|js|py|txt|csv|html|pdf)$/i

/**
 * Citações do catálogo no texto das páginas (`conector/endpoint` ou o id em código inline) que
 * apontam para o que não existe mais: um endpoint ou cenário de um conector que existe, ou um id
 * com o prefixo dos ids do projeto (connector.x, flow.y) que nenhum conector ou fluxo tem. As
 * diretivas {{> ...}} o validate já confere; blocos de código ficam de fora.
 */
export function staleReferences(file: string, text: string, catalog: ArchitectureCatalog): DriftItem[] {
  const connectors = new Map(catalog.connectors.map((c) => [c.id, c]))
  const flowIds = new Set(catalog.flows.map((f) => f.flow.id))
  const connectorPrefix = commonPrefix([...connectors.keys()])
  const flowPrefix = commonPrefix([...flowIds])
  const looksLike = (id: string, prefix: string[]) =>
    prefix.length > 0 && id.split(/[.\-_/:]+/).slice(0, prefix.length).join('\0') === prefix.join('\0') && id.split(/[.\-_/:]+/).length > prefix.length
  const items: DriftItem[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE.exec(lines[i]!)
    if (fence) {
      i = closeOf(lines, i, fence[1]!)
      continue
    }
    const line = lines[i]!.replace(/\{\{>[^}]*\}\}/g, '')
    for (const m of line.matchAll(INLINE_CODE)) {
      const token = m[1]!.trim()
      if (FILE_LIKE.test(token)) continue
      const parts = token.split('/')
      if (!parts.every((p) => ID_LIKE.test(p)) || parts.length > 3) continue
      const [cid, eid, sid] = parts as [string, string?, string?]
      const c = connectors.get(cid)
      const push = (message: string, hint: string) => items.push({ code: 'doc-unknown-reference', message, hint, file, line: i + 1, label: token })
      if (c) {
        if (eid === undefined) continue
        const e = c.endpoints?.find((x) => x.id === eid)
        if (!e) push(`a página cita ${cid}/${eid}, mas o conector ${cid} não tem mais esse endpoint`, `Atualize o texto (find_references e replace_references ajudam) ou tire a citação.`)
        else if (sid !== undefined && !e.scenarios?.some((s) => s.id === sid)) push(`a página cita o cenário ${token}, que não existe mais`, 'Atualize o texto ou tire a citação.')
        continue
      }
      if (parts.length === 1 && flowIds.has(cid)) continue
      if (looksLike(cid, connectorPrefix) && !flowIds.has(cid)) push(`a página cita ${token}, mas o conector ${cid} não existe mais no workspace`, 'Atualize o texto: o conector foi removido ou renomeado.')
      else if (parts.length === 1 && looksLike(cid, flowPrefix)) push(`a página cita o fluxo ${cid}, que não existe mais no workspace`, 'Atualize o texto: o fluxo foi removido ou renomeado.')
    }
  }
  return items
}

// --- Página velha pelo histórico ---

/** O que importa de um conector para a arquitetura: endpoints, origem, auth e herança. */
export interface StructureSignature {
  endpoints: string[]
  baseUrl?: string
  basePath?: string
  auth?: string
  extends?: string
  /** Num fluxo: os conectores que ele chama. */
  calls?: string[]
}

/** A assinatura estrutural de um conector (como está no arquivo) ou de um fluxo. */
export function structureSignature(item: unknown): StructureSignature | null {
  if (typeof item !== 'object' || item === null) return null
  const o = item as Record<string, unknown>
  if (Array.isArray(o['nodes']) && !o['defaults']) {
    try {
      return { endpoints: [], calls: [...flowConnectors(o as unknown as Flow)].sort() }
    } catch {
      return null
    }
  }
  const config = (o['config'] ?? o['defaults'] ?? {}) as Record<string, unknown>
  const auth = config['auth'] as Record<string, unknown> | undefined
  const endpoints = Array.isArray(o['endpoints'])
    ? (o['endpoints'] as Record<string, unknown>[]).map((e) => `${String(e['method'] ?? '')} ${String(e['path'] ?? '')} ${String(e['id'] ?? '')}`.trim()).sort()
    : []
  return {
    endpoints,
    ...(typeof config['baseUrl'] === 'string' && { baseUrl: config['baseUrl'] }),
    ...(typeof config['basePath'] === 'string' && { basePath: config['basePath'] }),
    ...(typeof auth?.['type'] === 'string' && { auth: auth['type'] }),
    ...(typeof o['extends'] === 'string' && { extends: o['extends'] })
  }
}

/** O que mudou entre duas assinaturas, em palavras; vazio: nada que a arquitetura mostre. */
export function describeStructureChange(before: StructureSignature, after: StructureSignature): string[] {
  const out: string[] = []
  const idOf = (e: string) => e.split(' ').at(-1)!
  const beforeIds = new Map(before.endpoints.map((e) => [idOf(e), e]))
  const afterIds = new Map(after.endpoints.map((e) => [idOf(e), e]))
  for (const [id, e] of afterIds) if (!beforeIds.has(id)) out.push(`+endpoint ${id}`)
    else if (beforeIds.get(id) !== e) out.push(`endpoint ${id} mudou de caminho`)
  for (const id of beforeIds.keys()) if (!afterIds.has(id)) out.push(`-endpoint ${id}`)
  for (const key of ['baseUrl', 'basePath', 'auth', 'extends'] as const) {
    if (before[key] !== after[key]) out.push(`${key} ${before[key] ?? '(nenhum)'} → ${after[key] ?? '(nenhum)'}`)
  }
  const calls = (s: StructureSignature) => new Set(s.calls ?? [])
  for (const c of calls(after)) if (!calls(before).has(c)) out.push(`passou a chamar ${c}`)
  for (const c of calls(before)) if (!calls(after).has(c)) out.push(`deixou de chamar ${c}`)
  return out
}
