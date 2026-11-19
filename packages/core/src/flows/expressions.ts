import { ConfigError } from '../connectors/errors'

/** Saída de um nó como fica em $nodes.<nome>: data é o principal; requisições trazem também status e headers. */
export interface NodeOutput {
  readonly data: unknown
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly durationMs?: number
}

/** A árvore $nodes vista por um nó: só os nós anteriores a ele no grafo, congelados. */
export type NodesTree = Readonly<Record<string, NodeOutput>>

/** Uma referência {{ $nodes... }} que não pôde ser resolvida. */
export class ExpressionError extends ConfigError {}

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g
const EXACT = /^\{\{\s*(\$nodes[.[][^{}]*?)\s*\}\}$/
const NODES_REF = /^\$nodes\.([A-Za-z_][A-Za-z0-9_]*)(.*)$/s

/** Congela o valor e tudo dentro dele: a saída de um nó não muda depois que ele termina. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

/**
 * Lê um caminho como $nodes.Login.data.items[0].id. Um nó que não está na árvore
 * (não existe, ou não é anterior a quem lê) é erro; um campo ausente é undefined.
 */
export function readPath(expression: string, nodes: NodesTree, elsewhere?: ReadonlySet<string>): unknown {
  // elsewhere: nós do fluxo que não são anteriores a quem lê, para a mensagem de erro.
  const match = NODES_REF.exec(expression.trim())
  if (!match) throw new ExpressionError(`expressão inválida "${expression}": use $nodes.Nome.data.campo`)
  const [, name, rest] = match as unknown as [string, string, string]
  if (!Object.hasOwn(nodes, name)) {
    const why = elsewhere?.has(name) ? 'não é anterior a este nó no grafo' : 'não existe no fluxo ou não rodou'
    throw new ExpressionError(`$nodes.${name}: o nó ${name} ${why}`)
  }
  let current: unknown = nodes[name]
  for (const part of rest.match(/[^.[\]]+/g) ?? []) {
    const key = part.replace(/^(["'])(.*)\1$/, '$2')
    if (Array.isArray(current) && /^\d+$/.test(key)) current = current[Number(key)]
    else if (current && typeof current === 'object' && Object.hasOwn(current, key)) current = (current as Record<string, unknown>)[key]
    else return undefined
  }
  return current
}

/** Valor obrigatório: um campo que não existe na saída é erro, para o fluxo não seguir com "undefined". */
export function readRequired(expression: string, nodes: NodesTree, elsewhere?: ReadonlySet<string>): unknown {
  const value = readPath(expression, nodes, elsewhere)
  if (value === undefined) {
    const name = NODES_REF.exec(expression.trim())?.[1]
    throw new ExpressionError(`{{ ${expression.trim()} }} não existe na saída de ${name}`)
  }
  return value
}

export function stringify(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
}

/** Se o texto é só uma referência {{ $nodes... }}, a expressão dentro dela. */
export function exactReference(text: string): string | undefined {
  return EXACT.exec(text)?.[1]
}

/** Nomes de nó citados como {{ $nodes.Nome... }} num valor JSON qualquer. */
export function referencedNodes(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const [, inner] of value.matchAll(TEMPLATE)) {
      const name = NODES_REF.exec(inner!.trim())?.[1]
      if (name) found.add(name)
    }
  } else if (Array.isArray(value)) {
    for (const v of value) referencedNodes(v, found)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) referencedNodes(v, found)
  }
  return found
}

/**
 * Troca as referências {{ $nodes... }} por marcadores {{$flow:N}} com o valor em
 * `extra`, para o envio resolver tudo numa passada só junto com os {{VAR}} do
 * ambiente. Dados de resposta nunca são interpolados de novo: um "{{API_TOKEN}}"
 * vindo de uma API não vira o segredo do ambiente.
 */
export class Substitutions {
  readonly extra: Record<string, string> = {}
  private readonly raw = new Map<string, unknown>()
  private count = 0

  constructor(
    private readonly nodes: NodesTree,
    private readonly elsewhere?: ReadonlySet<string>
  ) {}

  private register(value: string): string {
    const key = `$flow:${this.count++}`
    this.extra[key] = value
    return `{{${key}}}`
  }

  /** Texto com referências; `escape` adapta o valor ao contexto (URL, dentro de string JSON). */
  text(text: string, escape: (value: string) => string = (v) => v): string {
    return text.replace(TEMPLATE, (whole, inner: string) =>
      inner.trim().startsWith('$nodes') ? this.register(escape(stringify(readRequired(inner, this.nodes, this.elsewhere)))) : whole
    )
  }

  /**
   * Corpo JSON: um texto que é só uma referência vira o valor (número, objeto...);
   * referências no meio de um texto entram como texto. Devolve o JSON pronto, com
   * marcadores no lugar dos valores.
   */
  json(value: unknown): string {
    const marked = this.markJson(value)
    let text = JSON.stringify(marked) ?? ''
    for (const [marker, raw] of this.raw) text = text.replace(JSON.stringify(marker), () => this.register(JSON.stringify(raw) ?? 'null'))
    return text
  }

  private markJson(value: unknown): unknown {
    if (typeof value === 'string') {
      const exact = exactReference(value)
      if (exact !== undefined) {
        const raw = readRequired(exact, this.nodes, this.elsewhere)
        const marker = `\u0000vvflow:${this.raw.size}\u0000`
        this.raw.set(marker, raw)
        return marker
      }
      // Dentro de uma string JSON o valor precisa de escape (aspas, quebras de linha).
      return this.text(value, (v) => JSON.stringify(v).slice(1, -1))
    }
    if (Array.isArray(value)) return value.map((v) => this.markJson(v))
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.markJson(v)]))
    }
    return value
  }

  /** Valor tipado para a condição: um texto que é só uma referência vira o valor. */
  value(value: unknown): unknown {
    if (typeof value !== 'string') return value
    const exact = exactReference(value)
    return exact === undefined ? value : readPath(exact, this.nodes, this.elsewhere)
  }
}
