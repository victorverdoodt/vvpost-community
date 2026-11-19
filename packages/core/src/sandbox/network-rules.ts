/**
 * Regras de rede de um plugin (`permissions.network` no manifesto) e do nó Python
 * (`python.network` no fluxo). Uma regra é:
 *
 * - `*`: qualquer host (sem restrição);
 * - `api.example.com`, `*.example.com`, `10.0.0.5`, `[::1]`, cada um com `:porta` opcional;
 * - só no manifesto de plugin, `connector` (o host da baseUrl do conector do nó) e
 *   `config:<campo>` (os hosts escritos num campo da configuração do nó, ex.: brokers).
 *
 * `matchesNetworkRule` é serializada para dentro do processo do plugin (process-source.ts):
 * não pode usar nada de fora do próprio corpo.
 */

export const NETWORK_RULE_PATTERN =
  '^(\\*|connector|config:[A-Za-z_][A-Za-z0-9_]*|(\\*\\.)?[A-Za-z0-9_]([A-Za-z0-9_.-]*[A-Za-z0-9_])?(:[0-9]{1,5})?|\\[[0-9A-Fa-f:.]+\\](:[0-9]{1,5})?)$'

/** Uma regra concreta (sem connector/config:) vale para o host e a porta? Sem porta, só o host é conferido. */
export function matchesNetworkRule(rule: string, host: string, port: number | undefined): boolean {
  if (rule === '*') return true
  let h = String(host).toLowerCase().replace(/\.$/, '')
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  let r = rule.toLowerCase()
  let rulePort: number | undefined
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(r)
  if (v6) {
    r = v6[1]!
    if (v6[2]) rulePort = Number(v6[2])
  } else {
    const at = r.lastIndexOf(':')
    if (at > 0 && r.indexOf(':') === at) {
      rulePort = Number(r.slice(at + 1))
      r = r.slice(0, at)
    }
  }
  // Sem porta (uma consulta DNS), vale o host: a porta é conferida na conexão.
  if (rulePort !== undefined && port !== undefined && Number(port) !== rulePort) return false
  if (r.startsWith('*.')) return h.endsWith(r.slice(1)) && h.length > r.length - 1
  return h === r
}

export const networkAllows = (rules: readonly string[], host: string, port?: number): boolean =>
  rules.some((rule) => matchesNetworkRule(rule, host, port))

/** As regras que não dependem do nó: as que vão para o processo do plugin quando ele sobe. */
export const staticNetworkRules = (rules: readonly string[]): string[] =>
  rules.filter((r) => r !== 'connector' && !r.startsWith('config:'))

/** O plugin precisa de rede própria (fora do canal do host)? */
export const needsNetwork = (rules: readonly string[] | undefined): boolean => (rules?.length ?? 0) > 0

/** Hosts de um texto como "b1:9092, b2:9092" ou "grpcs://api.example.com:443", sem porta (a regra vale para o host). */
export function hostsOf(value: unknown): string[] {
  const texts = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : typeof value === 'string' ? [value] : []
  const hosts = new Set<string>()
  for (const text of texts) {
    for (const item of text.split(/[\s,;]+/).filter(Boolean)) {
      const host = hostOf(item)
      if (host) hosts.add(host)
    }
  }
  return [...hosts]
}

/** Host de uma URL ou de "host:porta" (IPv6 entre colchetes), em minúsculas. */
export function hostOf(item: string): string | null {
  const text = item.trim()
  if (!text || text.includes('{{')) return null
  // Curinga de subdomínio (ex.: *.kafka.us-east-1.amazonaws.com:9092) vale como regra.
  const wildcard = /^\*\.([A-Za-z0-9_.-]+?)(?::\d+)?$/.exec(text)
  if (wildcard) return `*.${wildcard[1]!.toLowerCase()}`
  try {
    const url = new URL(text.includes('://') ? text : `tcp://${text}`)
    const host = url.hostname.toLowerCase()
    if (!host) return null
    return host.startsWith('[') ? host : host.includes(':') ? `[${host}]` : host
  } catch {
    return null
  }
}

/**
 * As regras de uma chamada: `connector` vira o host da baseUrl já resolvida do conector
 * do nó, e `config:<campo>` os hosts escritos no campo. As regras fixas ficam de fora
 * (já estão no processo).
 */
export function callNetworkRules(rules: readonly string[], config: Record<string, unknown>, connectorBaseUrl: string | undefined): string[] {
  const out = new Set<string>()
  for (const rule of rules) {
    if (rule === 'connector') {
      const host = connectorBaseUrl ? hostOf(connectorBaseUrl) : null
      if (host) out.add(host)
    } else if (rule.startsWith('config:')) {
      for (const host of hostsOf(config[rule.slice('config:'.length)])) out.add(host)
    }
  }
  return [...out]
}

/** As regras como o Extensions Hub e a prévia de instalação mostram. */
export function describeNetworkRules(rules: readonly string[] | undefined, fieldLabel: (key: string) => string = (k) => k): string[] {
  if (!rules?.length) return []
  if (rules.includes('*')) return ['qualquer host (rede sem restrição)']
  return rules.map((rule) => {
    if (rule === 'connector') return 'o host do conector do nó'
    if (rule.startsWith('config:')) return `os hosts do campo "${fieldLabel(rule.slice('config:'.length))}"`
    return rule
  })
}
