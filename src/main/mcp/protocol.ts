// As duas eras do MCP que o servidor fala ("dual-era"):
// - legada (2024-11-05 a 2025-11-25): sessão aberta com initialize;
// - moderna (2026-07-28 em diante): sem handshake, cada pedido traz a versão e as capacidades em params._meta,
//   o servidor se apresenta em server/discover e todo resultado leva resultType.
// O pedido com _meta['io.modelcontextprotocol/protocolVersion'] é servido na era moderna; o resto, na legada.
// Spec: https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning

/** Versões modernas (por pedido), da mais nova para a mais antiga. */
export const MODERN_VERSIONS = ['2026-07-28'] as const
/** Versões com initialize, da mais nova para a mais antiga. */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const
/** Todas, como server/discover e o erro de versão anunciam. */
export const SUPPORTED_VERSIONS: readonly string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS]

export const META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  serverInfo: 'io.modelcontextprotocol/serverInfo'
} as const

/** Códigos da faixa reservada à spec (-32020 a -32099). */
export const ProtocolError = {
  HeaderMismatch: -32020,
  UnsupportedProtocolVersion: -32022
} as const

/** A versão moderna pedida em params._meta, ou undefined num pedido da era legada. */
export function requestedVersion(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined
  const meta = (params as Record<string, unknown>)['_meta']
  if (!meta || typeof meta !== 'object') return undefined
  const version = (meta as Record<string, unknown>)[META.protocolVersion]
  return typeof version === 'string' ? version : undefined
}

export const isModernVersion = (version: string) => (MODERN_VERSIONS as readonly string[]).includes(version)

/** Métodos cujo Mcp-Name espelha params.name ou params.uri. */
const NAMED_METHODS: Record<string, 'name' | 'uri'> = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' }

const BASE64 = /^=\?base64\?(.*)\?=$/

/** Valor de header do MCP, com a forma =?base64?...?= decodificada. */
export function decodeHeaderValue(value: string): string {
  const m = BASE64.exec(value)
  return m ? Buffer.from(m[1]!, 'base64').toString('utf8') : value
}

const headerOf = (headers: Record<string, string | string[] | undefined>, name: string) => {
  const v = headers[name.toLowerCase()]
  return Array.isArray(v) ? v[0] : v
}

/**
 * Streamable HTTP da era moderna: MCP-Protocol-Version, Mcp-Method e Mcp-Name têm de vir e bater com o corpo, para
 * que um proxy que roteia pelo header não veja outra coisa que o servidor executa. null: tudo certo.
 * Pedido legado (sem a versão moderna no _meta nem no header) passa sem conferência.
 */
export function headerMismatch(headers: Record<string, string | string[] | undefined>, message: unknown): string | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null
  const msg = message as { method?: unknown; params?: Record<string, unknown> }
  const bodyVersion = requestedVersion(msg.params)
  const headerVersion = headerOf(headers, 'MCP-Protocol-Version')
  if (bodyVersion === undefined) {
    // Cliente legado manda o header com a versão do initialize; versão moderna no header exige o _meta.
    return headerVersion && isModernVersion(headerVersion) ? `Header mismatch: MCP-Protocol-Version ${headerVersion} sem _meta.${META.protocolVersion} no corpo` : null
  }
  if (headerVersion === undefined) return 'Header mismatch: falta o header MCP-Protocol-Version'
  if (headerVersion !== bodyVersion) return `Header mismatch: MCP-Protocol-Version '${headerVersion}' não bate com o corpo ('${bodyVersion}')`
  if (typeof msg.method !== 'string') return null
  const method = headerOf(headers, 'Mcp-Method')
  if (method === undefined) return 'Header mismatch: falta o header Mcp-Method'
  if (method !== msg.method) return `Header mismatch: Mcp-Method '${method}' não bate com o corpo ('${msg.method}')`
  const field = NAMED_METHODS[msg.method]
  if (!field) return null
  const body = msg.params?.[field]
  if (typeof body !== 'string') return null
  const name = headerOf(headers, 'Mcp-Name')
  if (name === undefined) return 'Header mismatch: falta o header Mcp-Name'
  if (decodeHeaderValue(name) !== body) return `Header mismatch: Mcp-Name não bate com params.${field} do corpo`
  return null
}
