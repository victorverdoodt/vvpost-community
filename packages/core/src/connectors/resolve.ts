import type { Connector, ConnectorAuth, ConnectorTls, Endpoint } from '@vvpost/schemas'
import { authHeaderName } from './auth-contract'
import { ConfigError } from './errors'

/** Cadeia de extends mais longa que isto é erro: herança tão funda é acidente, não modelagem. */
export const MAX_INHERITANCE_DEPTH = 16

/**
 * Situação da herança que funciona por uma regra definida, mas que provavelmente não
 * é o que o autor quis. O Catálogo mostra; nada é bloqueado.
 */
export interface InheritanceWarning {
  code: 'INHERITED_AUTH_NEW_ORIGIN'
  /** Conector da cadeia onde está o problema. */
  connector: string
  message: string
}

/** Conector com a cadeia de `extends` já aplicada, do mais genérico ao mais específico. */
export interface ResolvedConnector {
  id: string
  name: string
  /** Ids da raiz até este conector. */
  chain: string[]
  baseUrl?: string
  /** basePaths da cadeia concatenados ("" se nenhum). */
  basePath: string
  /** Headers herdados; o filho sobrescreve o pai pelo nome, sem diferenciar maiúsculas. */
  headers: Record<string, string>
  /** Ausente quando ninguém na cadeia define auth, ou quando o mais próximo define `none`. */
  auth?: { config: Exclude<ConnectorAuth, { type: 'none' }>; from: string }
  tls?: { config: ConnectorTls; from: string }
  /** Scripts por requisição da cadeia, da raiz para este conector: todos rodam, em ordem. */
  scripts: { from: string; pre?: string; post?: string }[]
  endpoints: Endpoint[]
  warnings: InheritanceWarning[]
}


/**
 * Aplica a herança em cascata: baseUrl, headers,
 * auth e tls passam do pai para o filho, o basePath acumula e o que o filho
 * redefine vence. auth e tls são herdados inteiros, nunca mesclados campo a campo:
 * misturar o clientId do pai com o tokenUrl do filho geraria uma credencial que
 * ninguém escreveu. Conflitos sem vencedor óbvio são ConfigError: ciclo, pai
 * ausente, cadeia funda demais e header da cadeia com o nome do header da auth.
 */
export function resolveConnector(id: string, catalog: ReadonlyMap<string, Connector>): ResolvedConnector {
  const lineage: Connector[] = []
  const seen = new Set<string>()
  for (let current: string | undefined = id; current; ) {
    if (seen.has(current)) {
      const path = [...lineage.map((c) => c.id), current].join(' → ')
      throw new ConfigError(`herança circular: ${path}`)
    }
    seen.add(current)
    const connector = catalog.get(current)
    if (!connector) {
      throw new ConfigError(
        lineage.length
          ? `"${lineage.at(-1)!.id}" herda de "${current}", que não existe no workspace`
          : `conector "${current}" não existe no workspace`
      )
    }
    lineage.push(connector)
    if (lineage.length > MAX_INHERITANCE_DEPTH) {
      throw new ConfigError(`"${id}" tem mais de ${MAX_INHERITANCE_DEPTH} níveis de herança`)
    }
    current = connector.extends
  }
  lineage.reverse()

  const self = lineage.at(-1)!
  const resolved: ResolvedConnector = {
    id: self.id,
    name: self.name,
    chain: lineage.map((c) => c.id),
    basePath: '',
    headers: {},
    scripts: [],
    endpoints: self.endpoints ?? [],
    warnings: []
  }
  /** Origem da baseUrl em vigor quando a auth atual foi definida. */
  let authOrigin: string | undefined
  for (const { id: from, config } of lineage) {
    if (!config) continue
    if (config.scripts?.pre?.trim() || config.scripts?.post?.trim()) {
      resolved.scripts.push({ from, ...(config.scripts.pre?.trim() && { pre: config.scripts.pre }), ...(config.scripts.post?.trim() && { post: config.scripts.post }) })
    }
    if (config.baseUrl !== undefined && resolved.auth && !config.auth) {
      const before = staticOrigin(authOrigin)
      const after = staticOrigin(config.baseUrl)
      if (before && after && before !== after) {
        resolved.warnings.push({
          code: 'INHERITED_AUTH_NEW_ORIGIN',
          connector: from,
          message: `"${from}" troca a origem para ${after} e herda a auth de "${resolved.auth.from}", definida para ${before}: as credenciais vão para a nova origem`
        })
      }
    }
    if (config.baseUrl !== undefined) resolved.baseUrl = config.baseUrl
    if (config.basePath) resolved.basePath = joinPath(resolved.basePath, config.basePath)
    for (const [name, value] of Object.entries(config.headers ?? {})) setHeader(resolved.headers, name, value)
    if (config.auth) {
      resolved.auth = config.auth.type === 'none' ? undefined : { config: config.auth, from }
      authOrigin = resolved.baseUrl
    }
    if (config.tls) resolved.tls = { config: config.tls, from }
  }

  // A auth é dona do header dela: um header de mesmo nome na cadeia seria descartado em silêncio.
  const authHeader = resolved.auth && authHeaderName(resolved.auth.config)?.toLowerCase()
  if (authHeader) {
    for (const { id: from, config } of lineage) {
      const name = Object.keys(config?.headers ?? {}).find((n) => n.toLowerCase() === authHeader)
      if (name) {
        throw new ConfigError(
          `conflito de herança: "${from}" define o header ${name}, que é o header da auth de "${resolved.auth!.from}"; ` +
            'tire o header ou desligue a auth com { "type": "none" }'
        )
      }
    }
  }
  return resolved
}

/** Origem de uma baseUrl sem variáveis; com {{VAR}} a origem só existe no envio. */
function staticOrigin(url: string | undefined): string | undefined {
  if (!url || url.includes('{{')) return undefined
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

/** Junta segmentos de caminho sem barras duplicadas. */
export function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : `/${p.replace(/^\/+|\/+$/g, '')}`))
    .join('')
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase()
  for (const existing of Object.keys(headers)) if (existing.toLowerCase() === lower) delete headers[existing]
  headers[name] = value
}
