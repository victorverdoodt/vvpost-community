import { headingLine } from './markdown-format'

// Puro (sem DOM nem IPC), para os testes de unidade: os tipos abaixo cabem no DocRef e no DirectiveContext.

/** O arquivo que o Ctrl+clique abre: um DocRef das abas do workspace. */
export type DocTarget =
  | { kind: 'markdown'; file: string; section?: string }
  | { kind: 'connector'; connectorId: string }
  | { kind: 'endpoint'; connectorId: string; endpointId: string }
  | { kind: 'scenario'; connectorId: string; endpointId: string; scenarioId: string }
  | { kind: 'diagram'; file: string }

/** O que o destino precisa saber dos conectores do catálogo. */
export interface TargetContext {
  connectors: { id: string; name: string; file?: string; asFlow?: true; endpoints: { id: string; name: string; method: string }[] }[]
}

/** Uma diretiva {{> tipo argumento}} sozinha na linha, com as colunas dela (de 1, como no Monaco). */
export interface DirectiveSpan {
  kind: string
  arg: string
  /** O texto da diretiva, de {{> até }}. */
  text: string
  startColumn: number
  endColumn: number
}

// A mesma forma que o compose aceita: até três espaços antes e nada depois do }}.
const DIRECTIVE = /^(\s{0,3})(\{\{>\s*([A-Za-z0-9-]+)(?:\s+(.*?))?\s*\}\})\s*$/

export function directiveAt(line: string): DirectiveSpan | null {
  const m = DIRECTIVE.exec(line)
  if (!m) return null
  const start = m[1]!.length + 1
  return { kind: m[3]!, arg: (m[4] ?? '').trim(), text: m[2]!, startColumn: start, endColumn: start + m[2]!.length }
}

/**
 * O arquivo de onde vem o trecho de uma diretiva, para o Ctrl+clique abrir e editar: o Markdown
 * do include (na seção), o conector (ou o Markdown do fluxo-base que o define), o endpoint, o
 * cenário e o .mmd do diagrama. null: a diretiva é gerada do projeto inteiro e não tem um arquivo.
 */
export function directiveTarget(d: Pick<DirectiveSpan, 'kind' | 'arg'>, ctx: TargetContext): DocTarget | null {
  const parts = d.arg.split('/')
  switch (d.kind) {
    case 'include': {
      const hash = d.arg.indexOf('#')
      const file = hash < 0 ? d.arg : d.arg.slice(0, hash)
      if (!file) return null
      const section = hash < 0 ? '' : d.arg.slice(hash + 1)
      return section ? { kind: 'markdown', file, section } : { kind: 'markdown', file }
    }
    case 'connector': {
      if (!d.arg) return null
      const c = ctx.connectors.find((x) => x.id === d.arg)
      // Um conector escrito num fluxo-base (docs/flows.md, Herança) se edita no Markdown dele.
      if (c?.asFlow && c.file) return { kind: 'markdown', file: c.file }
      return { kind: 'connector', connectorId: d.arg }
    }
    case 'endpoint':
      return parts.length === 2 && parts[0] && parts[1] ? { kind: 'endpoint', connectorId: parts[0], endpointId: parts[1] } : null
    case 'request':
      return parts.length === 3 && parts.every(Boolean)
        ? { kind: 'scenario', connectorId: parts[0]!, endpointId: parts[1]!, scenarioId: parts[2]! }
        : null
    case 'diagram':
      return d.arg ? { kind: 'diagram', file: d.arg } : null
    default:
      return null
  }
}

/** Como o destino aparece no "Ctrl+clique abre ...". */
export function targetLabel(t: DocTarget, ctx: TargetContext): string {
  const connector = (id: string) => ctx.connectors.find((c) => c.id === id)
  switch (t.kind) {
    case 'markdown':
      return t.section ? `${t.file}, na seção ${t.section}` : t.file
    case 'connector':
      return `o conector ${connector(t.connectorId)?.name ?? t.connectorId}`
    case 'endpoint': {
      const e = connector(t.connectorId)?.endpoints.find((x) => x.id === t.endpointId)
      return `o endpoint ${e ? `${e.method} ${e.name}` : `${t.connectorId}/${t.endpointId}`}`
    }
    case 'scenario':
      return `o cenário ${t.connectorId}/${t.endpointId}/${t.scenarioId}`
    case 'diagram':
      return t.file
  }
}

/** A linha do título da seção pedida num include: pelo {#id}, pelo slug que o projeto conhece ou pelo título. */
export function sectionLine(text: string, section: string, sections: { id: string; title: string }[] = []): number | null {
  const lines = text.split('\n')
  const anchored = lines.findIndex((l) => /^\s{0,3}#{1,6}\s/.test(l) && l.includes(`{#${section}}`))
  if (anchored >= 0) return anchored + 1
  const known = sections.find((s) => s.id === section)
  return headingLine(text, known?.title ?? section)
}

